import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const distRoot = path.join(repoRoot, "packages/hub/public/apps/client/dist");
const npmOutDir = path.join(distRoot, "npm");
const pythonOutDir = path.join(distRoot, "python");
const certsOutDir = path.join(distRoot, "certs");
const pythonCommand = process.env.SUPERHUB_PYTHON || "python3";

async function ensureCleanDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf8",
    ...options
  });
}

function runLogged(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options
  });
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

async function buildNodeDist() {
  console.log("[client:dist] building @superhub/sdk");
  runLogged("npm", ["run", "--workspace", "@superhub/sdk", "build"]);

  const sdkDir = path.join(repoRoot, "packages/sdk");
  const npmCacheDir = path.join(os.tmpdir(), "superhub-npm-cache");
  await fsp.mkdir(npmCacheDir, { recursive: true });

  console.log("[client:dist] packing @superhub/sdk");
  const raw = execFileSync("npm", ["pack", "--json"], {
    cwd: sdkDir,
    stdio: "pipe",
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: npmCacheDir
    }
  });

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0]?.filename) {
    throw new Error("npm pack did not return a filename");
  }

  const tgzName = parsed[0].filename;
  const tgzSrc = path.join(sdkDir, tgzName);
  const tgzDest = path.join(npmOutDir, tgzName);
  const latestDest = path.join(npmOutDir, "superhub-sdk-latest.tgz");

  copyFile(tgzSrc, tgzDest);
  copyFile(tgzSrc, latestDest);
  fs.rmSync(tgzSrc, { force: true });

  return {
    fileName: tgzName,
    latestName: "superhub-sdk-latest.tgz"
  };
}

async function buildPythonDist() {
  const pythonPkgDir = path.join(repoRoot, "client/python-lib");
  if (!fs.existsSync(pythonPkgDir)) {
    throw new Error(`Python package directory not found: ${pythonPkgDir}`);
  }

  console.log("[client:dist] building Python distributions");
  let usedFallback = false;
  let usedManualWheel = false;
  const forceManualWheel = process.env.SUPERHUB_CLIENT_FORCE_MANUAL_WHEEL === "1";

  try {
    if (forceManualWheel) {
      throw new Error("manual wheel forced by SUPERHUB_CLIENT_FORCE_MANUAL_WHEEL=1");
    }
    runLogged(pythonCommand, ["-m", "build", pythonPkgDir, "--sdist", "--wheel", "--outdir", pythonOutDir]);
  } catch (error) {
    usedFallback = true;
    console.warn("[client:dist] python -m build unavailable, fallback to pip wheel");
    try {
      if (forceManualWheel) {
        throw new Error("manual wheel forced by SUPERHUB_CLIENT_FORCE_MANUAL_WHEEL=1");
      }
      runLogged(pythonCommand, [
        "-m",
        "pip",
        "wheel",
        "--no-deps",
        "--no-build-isolation",
        "--wheel-dir",
        pythonOutDir,
        pythonPkgDir
      ]);
    } catch (pipError) {
      usedManualWheel = true;
      console.warn("[client:dist] pip wheel failed, fallback to manual wheel generation");
      await buildPythonWheelManually({ pythonPkgDir, pythonOutDir });
    }
  }

  const files = fs.readdirSync(pythonOutDir).filter((name) => !name.startsWith("."));
  const wheels = files.filter((name) => name.endsWith(".whl")).sort();
  const sdists = files.filter((name) => name.endsWith(".tar.gz")).sort();

  const latestWheel = wheels[wheels.length - 1] ?? null;
  const latestSdist = sdists[sdists.length - 1] ?? null;

  if (latestWheel) {
    await fsp.writeFile(path.join(pythonOutDir, "latest-wheel.txt"), `${latestWheel}\n`, "utf8");
  }
  if (latestSdist) {
    await fsp.writeFile(path.join(pythonOutDir, "latest-sdist.txt"), `${latestSdist}\n`, "utf8");
  }

  await writePythonSimpleIndex({
    wheel: latestWheel,
    sdist: latestSdist
  });

  return {
    usedFallback,
    usedManualWheel,
    wheel: latestWheel,
    sdist: latestSdist
  };
}

async function publishCaddyRootCert() {
  const candidates = [
    process.env.SUPERHUB_CADDY_ROOT_CERT,
    path.join(os.homedir(), "Library", "Application Support", "Caddy", "pki", "authorities", "local", "root.crt"),
    path.join(os.homedir(), ".local", "share", "caddy", "pki", "authorities", "local", "root.crt")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    await fsp.mkdir(certsOutDir, { recursive: true });
    const dest = path.join(certsOutDir, "caddy-local-root.crt");
    copyFile(candidate, dest);
    return {
      sourcePath: candidate,
      fileName: "caddy-local-root.crt"
    };
  }

  return null;
}

async function buildPythonWheelManually({ pythonPkgDir, pythonOutDir }) {
  const pyproject = await fsp.readFile(path.join(pythonPkgDir, "pyproject.toml"), "utf8");
  const projectName = extractPyprojectField(pyproject, "name") || "superhub-client";
  const projectVersion = extractPyprojectField(pyproject, "version") || "0.1.0";
  const projectDescription = extractPyprojectField(pyproject, "description") || "SuperHub Python client";
  const requiresPython = extractPyprojectField(pyproject, "requires-python") || ">=3.10";

  const canonicalName = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const normalizedName = projectName.replace(/[-.]+/g, "_");
  const wheelName = `${normalizedName}-${projectVersion}-py3-none-any.whl`;
  const wheelPath = path.join(pythonOutDir, wheelName);
  const packageDir = path.join(pythonPkgDir, "superhub_client");

  if (!fs.existsSync(packageDir)) {
    throw new Error(`Python package dir not found for manual wheel: ${packageDir}`);
  }

  const metadata = [
    "Metadata-Version: 2.1",
    `Name: ${canonicalName}`,
    `Version: ${projectVersion}`,
    `Summary: ${projectDescription}`,
    `Requires-Python: ${requiresPython}`,
    "Requires-Dist: websockets (>=12,<16)",
    ""
  ].join("\n");

  const wheel = [
    "Wheel-Version: 1.0",
    "Generator: superhub-client-dist",
    "Root-Is-Purelib: true",
    "Tag: py3-none-any",
    ""
  ].join("\n");

  const distInfoDir = `${normalizedName}-${projectVersion}.dist-info`;
  const manualBuilder = `
import base64
import hashlib
import pathlib
import zipfile

package_dir = pathlib.Path(r"""${packageDir}""")
wheel_path = pathlib.Path(r"""${wheelPath}""")
dist_info_dir = "${distInfoDir}"
metadata = """${escapeForPythonTripleQuote(metadata)}"""
wheel = """${escapeForPythonTripleQuote(wheel)}"""

files = []
wheel_path.parent.mkdir(parents=True, exist_ok=True)

def add_bytes(zf, arcname, data):
    zf.writestr(arcname, data)
    files.append((arcname, data))

with zipfile.ZipFile(wheel_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(package_dir.rglob("*")):
        if not path.is_file():
            continue
        if "__pycache__" in path.parts or path.name.endswith(".pyc"):
            continue
        arc = "superhub_client/" + path.relative_to(package_dir).as_posix()
        data = path.read_bytes()
        add_bytes(zf, arc, data)

    add_bytes(zf, f"{dist_info_dir}/METADATA", metadata.encode("utf-8"))
    add_bytes(zf, f"{dist_info_dir}/WHEEL", wheel.encode("utf-8"))

    record_path = f"{dist_info_dir}/RECORD"
    rows = []
    for arc, data in files:
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode("ascii").rstrip("=")
        rows.append(f"{arc},sha256={digest},{len(data)}")
    rows.append(f"{record_path},,")
    zf.writestr(record_path, ("\\n".join(rows) + "\\n").encode("utf-8"))
`;

  runLogged(pythonCommand, ["-c", manualBuilder]);
}

function extractPyprojectField(pyprojectContent, fieldName) {
  const match = pyprojectContent.match(new RegExp(`^${fieldName}\\s*=\\s*"(.*)"\\s*$`, "m"));
  return match?.[1] ?? null;
}

function escapeForPythonTripleQuote(value) {
  return value.replace(/"""/g, '\\"\\"\\"');
}

async function writePythonSimpleIndex(pythonMeta) {
  const simpleRoot = path.join(pythonOutDir, "simple");
  const packageIndexDir = path.join(simpleRoot, "superhub-client");
  await fsp.mkdir(packageIndexDir, { recursive: true });

  const rootHtml = `<!doctype html>
<html><body>
  <a href="superhub-client/">superhub-client</a>
</body></html>
`;
  await fsp.writeFile(path.join(simpleRoot, "index.html"), rootHtml, "utf8");

  const links = [];
  if (pythonMeta.wheel) {
    links.push(`<a href="../../${pythonMeta.wheel}">${pythonMeta.wheel}</a>`);
  }
  if (pythonMeta.sdist) {
    links.push(`<a href="../../${pythonMeta.sdist}">${pythonMeta.sdist}</a>`);
  }

  const packageHtml = `<!doctype html>
<html><body>
  ${links.length > 0 ? links.join("<br/>\n  ") : "<em>No artifacts</em>"}
</body></html>
`;
  await fsp.writeFile(path.join(packageIndexDir, "index.html"), packageHtml, "utf8");
}

async function writeIndex(nodeMeta, pythonMeta, certMeta) {
  const host = "macbook-pro-de-olivier.local";
  const certSection = certMeta
    ? `<div class="box">
      <h2>TLS bootstrap (clients)</h2>
      <p>Download local CA: <a href="./certs/${certMeta.fileName}">${certMeta.fileName}</a></p>
      <pre>curl -k "https://${host}/apps/client/dist/certs/${certMeta.fileName}" -o "$HOME/.superhub-caddy-root.crt"</pre>
      <pre>pip install --cert "$HOME/.superhub-caddy-root.crt" --extra-index-url "https://${host}/apps/client/dist/python/simple/" superhub-client</pre>
      <pre>npm_config_cafile="$HOME/.superhub-caddy-root.crt" npm install "https://${host}/apps/client/dist/npm/${nodeMeta.latestName}"</pre>
    </div>`
    : `<div class="box">
      <h2>TLS bootstrap (clients)</h2>
      <p><em>Caddy root cert not found locally. Set SUPERHUB_CADDY_ROOT_CERT and rebuild.</em></p>
    </div>`;

  const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>SuperHub Client Distributions</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; line-height: 1.5; }
      code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
      pre { background: #1e293b; color: #f8fafc; padding: 16px; border-radius: 8px; overflow-x: auto; line-height: 1.4; }
      .box { border: 1px solid #d1d5db; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    </style>
  </head>
  <body>
    <h1>SuperHub Client Distributions</h1>
    <p>Host this page from <code>https://${host}/apps/client/dist/</code>.</p>

    <div class="box">
      <h2>Node / React</h2>
      <p>Latest package: <a href="./npm/${nodeMeta.latestName}">${nodeMeta.latestName}</a></p>
      <pre>npm install "https://${host}/apps/client/dist/npm/${nodeMeta.latestName}"</pre>
    </div>

    <div class="box">
      <h2>Python</h2>
      <p>Latest wheel: ${pythonMeta.wheel
      ? `<a href="./python/${pythonMeta.wheel}">${pythonMeta.wheel}</a>`
      : "<em>not built</em>"
    }</p>
      <p>Latest sdist: ${pythonMeta.sdist
      ? `<a href="./python/${pythonMeta.sdist}">${pythonMeta.sdist}</a>`
      : "<em>not built</em>"
    }</p>
      <pre>pip install --extra-index-url "https://${host}/apps/client/dist/python/simple/" superhub-client</pre>
      <pre>HUB_HTTP_URL="https://${host}" \\
HUB_TOKEN="CHANGE_ME_SUPERHUB_TOKEN" \\
HUB_TLS_CA_FILE="$HOME/.superhub-caddy-root.crt" \\
python -m superhub_client.examples.iss_updater --hz 10</pre>
    </div>

    ${certSection}
  </body>
</html>
`;

  await fsp.mkdir(distRoot, { recursive: true });
  await fsp.writeFile(path.join(distRoot, "index.html"), indexHtml, "utf8");

  const metadata = {
    generatedAt: new Date().toISOString(),
    host,
    cert: certMeta,
    npm: nodeMeta,
    python: pythonMeta
  };
  await fsp.writeFile(path.join(distRoot, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
}

async function main() {
  await ensureCleanDir(npmOutDir);
  await ensureCleanDir(pythonOutDir);
  await ensureCleanDir(certsOutDir);

  const nodeMeta = await buildNodeDist();
  const pythonMeta = await buildPythonDist();
  const certMeta = await publishCaddyRootCert();
  await writeIndex(nodeMeta, pythonMeta, certMeta);

  console.log("[client:dist] done");
  console.log(`[client:dist] open: https://macbook-pro-de-olivier.local/apps/client/dist/`);
}

main().catch((error) => {
  console.error("[client:dist] failed");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
