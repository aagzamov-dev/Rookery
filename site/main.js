// Rookery website: download links from the latest GitHub release, install steps after a download,
// the screen tour, copy buttons and the phone menu. No libraries, no tracking.
(() => {
  "use strict";

  const REPO = "aagzamov-dev/Rookery";
  const RELEASES = `https://github.com/${REPO}/releases/latest`;
  const COMMAND = 'xattr -dr com.apple.quarantine "/Applications/Rookery.app"';
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  // ------------------------------------------------------------ toast + copy

  const toast = $(".toast");
  let toastTimer = 0;
  function say(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 1800);
  }

  async function copy(text, done) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement("textarea");
      t.value = text;
      t.setAttribute("readonly", "");
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.append(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    say(done);
  }

  $$("[data-copy-cmd]").forEach((b) =>
    b.addEventListener("click", () => {
      copy(COMMAND, "Command copied. Paste it into Terminal.");
      const label = b.textContent;
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = label), 1500);
    }),
  );
  $$("[data-copy-link]").forEach((b) => b.addEventListener("click", () => copy(location.href.split("#")[0], "Link copied.")));

  // ------------------------------------------------------------ latest release

  const links = { windows: RELEASES, mac: RELEASES };
  const files = { windows: "", mac: "" };

  function apply(version) {
    $$("[data-dl]").forEach((a) => (a.href = links[a.dataset.dl]));
    $$("[data-dl-again]").forEach((a) => (a.href = links[a.dataset.dlAgain]));
    $$("[data-file]").forEach((s) => files[s.dataset.file] && (s.textContent = files[s.dataset.file]));
    if (version) $$("[data-version]").forEach((s) => (s.textContent = `Version ${version}`));
  }

  function fromRelease(rel) {
    const find = (re) => (rel.assets || []).find((a) => re.test(a.name));
    const exe = find(/_x64-setup\.exe$/i);
    const dmg = find(/\.dmg$/i);
    if (exe) [links.windows, files.windows] = [exe.browser_download_url, exe.name];
    if (dmg) [links.mac, files.mac] = [dmg.browser_download_url, dmg.name];
    apply(String(rel.tag_name || "").replace(/^v/, ""));
  }

  (async () => {
    const KEY = "rookery.release";
    try {
      const cached = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) return fromRelease(cached.rel);
    } catch {
      /* storage blocked: fetch */
    }
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
      if (!r.ok) return;
      const rel = await r.json();
      fromRelease(rel);
      try {
        sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), rel: { tag_name: rel.tag_name, assets: (rel.assets || []).map((a) => ({ name: a.name, browser_download_url: a.browser_download_url })) } }));
      } catch {
        /* fine */
      }
    } catch {
      /* offline or rate-limited: the buttons open the releases page */
    }
  })();

  // ------------------------------------------------------------ download → steps

  const dialogs = { mac: $("#dlg-mac"), windows: $("#dlg-windows") };

  $$("[data-dl]").forEach((a) =>
    a.addEventListener("click", (e) => {
      const os = a.dataset.dl;
      // No direct file known yet: open the releases page in a new tab, still show the steps.
      if (a.href === RELEASES) {
        e.preventDefault();
        window.open(RELEASES, "_blank", "noopener");
      }
      const d = dialogs[os];
      if (d && typeof d.showModal === "function") d.showModal();
    }),
  );

  Object.values(dialogs).forEach((d) => {
    if (!d) return;
    $$("[data-close]", d).forEach((b) => b.addEventListener("click", () => d.close()));
    // A click on the dimmed area closes it.
    d.addEventListener("click", (e) => e.target === d && d.close());
  });

  // ------------------------------------------------------------ phones

  const ua = navigator.userAgent;
  // iPads report themselves as a Mac with a touch screen.
  const phone = /Android|iPhone|iPod|iPad/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (phone) $$(".phone-note").forEach((n) => (n.hidden = false));

  const menu = $(".nav-menu");
  const navLinks = $("#nav-links");
  menu.addEventListener("click", () => {
    const open = navLinks.classList.toggle("open");
    menu.setAttribute("aria-expanded", String(open));
  });
  $$("a", navLinks).forEach((a) =>
    a.addEventListener("click", () => {
      navLinks.classList.remove("open");
      menu.setAttribute("aria-expanded", "false");
    }),
  );

  // ------------------------------------------------------------ the tour (slider)

  const track = $(".tour-track");
  const slides = $$(".slide", track);
  const tabs = $$(".tour-tabs [data-slide]");
  let current = 0;

  function show(i, smooth = true) {
    current = (i + slides.length) % slides.length;
    track.scrollTo({ left: current * track.clientWidth, behavior: smooth ? "smooth" : "auto" });
    mark(current);
  }
  function mark(i) {
    tabs.forEach((t, j) => t.setAttribute("aria-selected", String(j === i)));
    const tab = tabs[i];
    if (tab && tab.parentElement.scrollWidth > tab.parentElement.clientWidth) {
      tab.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
  }

  tabs.forEach((t) => t.addEventListener("click", () => show(Number(t.dataset.slide))));
  $(".tour-arrow.prev").addEventListener("click", () => show(current - 1));
  $(".tour-arrow.next").addEventListener("click", () => show(current + 1));
  track.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      show(current + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      show(current - 1);
    }
  });

  // Swiping (touch or trackpad) moves the selected tab along.
  let raf = 0;
  track.addEventListener("scroll", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      if (i !== current) {
        current = i;
        mark(i);
      }
    });
  });
  window.addEventListener("resize", () => show(current, false));
})();
