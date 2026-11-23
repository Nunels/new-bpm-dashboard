/* Copia il risultato della build in js/vendor/open-workflow-editor/ insieme alle licenze delle librerie principali incluse nel bundle. */
const fs = require("fs");
const path = require("path");

const out = process.argv[2] || path.join(__dirname, "..", "..", "js", "vendor", "open-workflow-editor");
fs.mkdirSync(out, { recursive: true });
["diagram-editor.iife.js", "diagram-editor.css"].forEach((f) => fs.copyFileSync(path.join(__dirname, "dist", f), path.join(out, f)));

const nm = (p) => path.join(__dirname, "node_modules", p);
const pkg = (p) => JSON.parse(fs.readFileSync(path.join(nm(p), "package.json"), "utf8"));
const editor = pkg("@openworkflowspec/diagram-editor");
const names = Object.keys(editor.dependencies).concat(["@openworkflowspec/diagram-editor", "react", "react-dom"]);
const rows = names.sort().map((n) => {
  const p = pkg(n);
  return "- " + n + " " + p.version + " — " + (typeof p.license === "string" ? p.license : JSON.stringify(p.license));
});
const notice = [
  "Bundle generato da tools/open-workflow-viewer (npm run build). Non modificare a mano.",
  "",
  "Contiene @openworkflowspec/diagram-editor (Apache-2.0, https://github.com/open-workflow-specification/editor) e le sue dipendenze.",
  "Librerie principali incluse (licenza dichiarata nel package.json):",
  ...rows,
  "",
  "elkjs è doppia licenza EPL-2.0 OR GPL-3.0-or-later: viene usato sotto la Eclipse Public License 2.0 (come indicato dal README del pacchetto).",
  "Le licenze delle dipendenze transitive sono nel pacchetto npm corrispondente (vedi package-lock.json).",
  "",
].join("\n");
fs.writeFileSync(path.join(out, "NOTICE.txt"), notice);
fs.copyFileSync(nm("@openworkflowspec/diagram-editor/LICENSE"), path.join(out, "LICENSE-open-workflow-editor.txt"));
const elk = ["LICENSE.md", "LICENSE"].map((f) => path.join(nm("elkjs"), f)).find((f) => fs.existsSync(f));
if (elk) fs.copyFileSync(elk, path.join(out, "LICENSE-elkjs.txt"));
console.log("copiato in", out);
