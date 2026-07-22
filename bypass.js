/*
 * SEB quiz-key validator — runs entirely in the browser console.
 *
 * HOW TO USE
 *   1. Log in to Moodle and open the quiz view page:
 *        https://lms.example.com/mod/quiz/view.php?id=XXXXXX
 *   2. Open DevTools console (F12 / Cmd+Opt+J).
 *   3. Paste this whole file and press Enter.
 */
(async () => {
  // Internal marker for the "escape backslashes as a single \" trick (see dumps()).
  // It is swapped in before serializing and fully swapped back out before hashing,
  // so it NEVER appears in the hashed output — it does NOT need to match seb.py.
  // The only requirement: it must never occur in the config data. U+F0000/U+F0001
  // are Unicode Private Use Area code points, which by definition never appear in
  // interchange text, so collision is impossible.
  const BACKSLASH_SUBSTITUTE = "\u{F0000}\u{F0001}";

  const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

  // ---- XML plist -> JS value -------------------------------------------------
  function parseNode(node) {
    switch (node.nodeName) {
      case "dict": {
        const obj = {};
        const kids = Array.from(node.children); // alternating <key>/<value>
        for (let i = 0; i < kids.length; i += 2) {
          obj[kids[i].textContent] = parseNode(kids[i + 1]);
        }
        return obj;
      }
      case "array":
        return Array.from(node.children).map(parseNode);
      case "string":
        return node.textContent;
      case "integer":
        return parseInt(node.textContent, 10);
      case "real":
        return parseFloat(node.textContent);
      case "true":
        return true;
      case "false":
        return false;
      case "data":
        // plistlib decodes then re-b64-encodes; stripping whitespace is the
        // canonical equivalent for standard base64.
        return node.textContent.replace(/\s+/g, "");
      case "date":
        return node.textContent; // rarely present in Moodle SEB configs
      default:
        return node.textContent;
    }
  }

  function parsePlist(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("config.php did not return a valid plist (are you logged in / is the cmid right?)");
    }
    const root = doc.querySelector("plist");
    const top = root && Array.from(root.children)[0];
    if (!top) throw new Error("Empty SEB plist");
    return parseNode(top);
  }

  // ---- prepare(): mirror seb.py rules ---------------------------------------
  function prepare(obj) {
    if (isPlainObject(obj)) {
      const out = {};
      for (const k of Object.keys(obj)) {
        const pv = prepare(obj[k]);
        if (isPlainObject(pv) && Object.keys(pv).length === 0) continue; // drop empty dicts
        out[k] = pv;
      }
      return out;
    }
    if (Array.isArray(obj)) {
      const out = [];
      for (const item of obj) {
        const pi = prepare(item);
        if (isPlainObject(pi) && Object.keys(pi).length === 0) continue;
        out.push(pi);
      }
      return out;
    }
    if (typeof obj === "string") {
      return obj.split("\\").join(BACKSLASH_SUBSTITUTE);
    }
    return obj; // numbers/bools handled in dumps()
  }

  // ---- custom_json_dumps(): case-insensitive key sort, no "/" escaping -------
  function dumps(obj) {
    if (obj === null) return "null";
    if (typeof obj === "boolean") return obj ? "true" : "false";
    if (typeof obj === "number") {
      // Python: str(int) as-is; floats rounded to 1 decimal (integers collapse).
      if (Number.isInteger(obj)) return String(obj);
      return String(Math.round(obj * 10) / 10);
    }
    if (typeof obj === "string") return JSON.stringify(obj); // no forward-slash escaping in JS
    if (Array.isArray(obj)) return "[" + obj.map(dumps).join(",") + "]";
    if (isPlainObject(obj)) {
      const keys = Object.keys(obj).sort((a, b) => {
        const A = a.toLowerCase(), B = b.toLowerCase();
        return A < B ? -1 : A > B ? 1 : 0;
      });
      return "{" + keys.map(k => dumps(k) + ":" + dumps(obj[k])).join(",") + "}";
    }
    throw new Error("Not JSON serializable: " + typeof obj);
  }

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function createConfigKey(xml) {
    const plist = parsePlist(xml);
    const url = plist.startURL || "";
    delete plist.originatorVersion;
    const prepared = prepare(plist);
    const jsonWithSubst = dumps(prepared);
    const finalJson = jsonWithSubst.split(BACKSLASH_SUBSTITUTE).join("\\");
    const jsonHash = await sha256Hex(finalJson);   // = SEB Config Key
    return sha256Hex(url + jsonHash);              // = Config Key Hash for startURL
  }

  // ---- main ------------------------------------------------------------------
  try {
    const cmid = new URLSearchParams(location.search).get("id");
    if (!cmid) throw new Error("Open this on the quiz page: .../mod/quiz/view.php?id=XXXX");

    const origin = location.origin;
    const sesskey = window.M && M.cfg && M.cfg.sesskey;
    if (!sesskey) throw new Error("Could not read M.cfg.sesskey — run this on a logged-in Moodle page.");

    console.log("[SEB] cmid =", cmid);
    const xml = await fetch(`${origin}/mod/quiz/accessrule/seb/config.php?cmid=${cmid}`, {
      credentials: "same-origin",
    }).then(r => r.text());

    const configkey = await createConfigKey(xml);
    console.log("[SEB] configkey =", configkey);

    const viewUrl = `${origin}/mod/quiz/view.php?id=${cmid}`;
    const payload = [{
      index: 0,
      methodname: "quizaccess_seb_validate_quiz_keys",
      args: { browserexamkey: "", configkey, url: viewUrl, cmid },
    }];

    const resp = await fetch(
      `${origin}/lib/ajax/service.php?sesskey=${sesskey}&info=quizaccess_seb_validate_quiz_keys`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    ).then(r => r.json());

    console.log("[SEB] response =", resp);
    const data = resp && resp[0] && resp[0].data;
    if (data && data.configkey && data.browserexamkey) {
      console.log("[SEB] Validated — reloading the quiz…");
      location.href = viewUrl;
    } else {
      console.error("[SEB] Validation failed:", resp);
      alert("SEB validation failed — see console.");
    }
  } catch (e) {
    console.error("[SEB] Error:", e);
    alert("SEB error: " + e.message);
  }
})();
