/**
 * One-time dig tips per platform (content + popup).
 */
(function (root) {
  const STORAGE_KEY = "diggerOnboardingV1";
  const TIP_ID = "digger-onboarding-tip";
  const STYLE_ID = "digger-onboarding-style";

  const COPY = {
    soundeo: {
      title: "So diggst du auf Soundeo",
      lines: [
        "Abspielen = Gehört",
        "Vormerken = später laden · WAV = sofort downloaden",
        "BPM & Zufall: Overlay unten rechts"
      ]
    },
    soundcloud: {
      title: "So diggst du auf SoundCloud",
      lines: [
        "Links: Filter, Tempo, Gehörte ausblenden",
        "Am Track: Vormerken",
        "Feed: „Nur anzeigen“ + Plays in einem Panel"
      ]
    },
    popup: {
      title: "Kurz erklärt",
      lines: [
        "Diggen auf der Seite · Setup & Sync hier im Popup",
        "Drei Zustände: Gehört · Vormerken · Bewertung"
      ]
    }
  };

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "#" +
      TIP_ID +
      "{position:fixed;z-index:2147483001;left:50%;bottom:24px;transform:translateX(-50%);" +
      "width:min(360px,calc(100vw - 32px));padding:14px 16px;border-radius:14px;" +
      "border:1px solid rgba(255,255,255,.12);background:rgba(18,21,26,.97);" +
      "color:#e8edf4;box-shadow:0 16px 40px rgba(0,0,0,.45);" +
      "font:500 13px/1.45 Segoe UI,system-ui,sans-serif;backdrop-filter:blur(10px)}" +
      "#" +
      TIP_ID +
      " .digger-ob-title{margin:0;font:700 14px/1.3 Segoe UI,system-ui,sans-serif;color:#fff}" +
      "#" +
      TIP_ID +
      " .digger-ob-list{margin:10px 0 0;padding:0 0 0 18px;color:#9aa7b8;font-size:12px}" +
      "#" +
      TIP_ID +
      " .digger-ob-list li{margin:4px 0}" +
      "#" +
      TIP_ID +
      " .digger-ob-actions{display:flex;justify-content:flex-end;margin-top:12px}" +
      "#" +
      TIP_ID +
      " .digger-ob-btn{border:0;border-radius:8px;padding:8px 12px;cursor:pointer;" +
      "background:#ff6a3d;color:#1a0f0a;font:700 12px Segoe UI,system-ui,sans-serif}" +
      "#" +
      TIP_ID +
      ".digger-ob-popup{position:static;transform:none;width:auto;left:auto;bottom:auto;" +
      "margin:0;box-shadow:none}";
    (document.head || document.documentElement).appendChild(style);
  }

  function closeTip() {
    const el = document.getElementById(TIP_ID);
    if (el) {
      try {
        el.remove();
      } catch (_) {}
    }
  }

  function markSeen(platform) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get([STORAGE_KEY], function (data) {
          const seen =
            data && data[STORAGE_KEY] && typeof data[STORAGE_KEY] === "object"
              ? data[STORAGE_KEY]
              : {};
          seen[platform] = true;
          chrome.storage.sync.set({ [STORAGE_KEY]: seen }, function () {
            resolve();
          });
        });
      } catch (_) {
        resolve();
      }
    });
  }

  function hasSeen(platform) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get([STORAGE_KEY], function (data) {
          const seen = data && data[STORAGE_KEY];
          resolve(Boolean(seen && seen[platform]));
        });
      } catch (_) {
        resolve(true);
      }
    });
  }

  function render(platform, asPopup) {
    const copy = COPY[platform];
    if (!copy || !document.body) return;
    closeTip();
    ensureStyles();

    const tip = document.createElement("div");
    tip.id = TIP_ID;
    tip.setAttribute("role", "status");
    if (asPopup) tip.className = "digger-ob-popup";

    const title = document.createElement("p");
    title.className = "digger-ob-title";
    title.textContent = copy.title;

    const list = document.createElement("ul");
    list.className = "digger-ob-list";
    for (let i = 0; i < copy.lines.length; i++) {
      const li = document.createElement("li");
      li.textContent = copy.lines[i];
      list.appendChild(li);
    }

    const actions = document.createElement("div");
    actions.className = "digger-ob-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "digger-ob-btn";
    btn.textContent = "Alles klar";
    btn.addEventListener("click", function () {
      markSeen(platform).then(closeTip);
    });
    actions.appendChild(btn);

    tip.appendChild(title);
    tip.appendChild(list);
    tip.appendChild(actions);

    if (asPopup) {
      const host = document.getElementById("dig-legend") || document.body;
      if (host.parentNode) host.parentNode.insertBefore(tip, host.nextSibling);
      else document.body.appendChild(tip);
    } else {
      document.body.appendChild(tip);
    }
  }

  function show(platform, options) {
    const opts = options || {};
    hasSeen(platform).then(function (seen) {
      if (seen) return;
      render(platform, Boolean(opts.popup));
    });
  }

  root.DiggerOnboarding = {
    show: show,
    dismiss: closeTip
  };
})(typeof window !== "undefined" ? window : self);
