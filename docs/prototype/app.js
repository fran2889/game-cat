/* Throwaway UI prototype for game-cat #6. Not production code. */

(() => {
  "use strict";

  const TODAY = new Date("2026-11-14T12:00:00Z");

  const state = {
    view: "library",
    activeSmartId: null,
    activeSteamId: null,
    draft: null,
    editorName: "",
    editorRules: [],
    dirty: false,
    search: "",
    sort: "name",
    order: "asc",
    installedOnly: false,
    layout: "grid",
    selected: new Set(),
    drawerAppId: null,
    gamePicker: null,
    scenario: "normal",
    refresh: { done: 0, total: GAMES.length },
    timer: { running: false, startedAt: 0, elapsed: 0 },
    focusAfterRender: null,
    focusMain: false,
    lastVisibleIds: [],
    protoOpen: window.innerWidth > 980,
  };

  let refreshTimer = null;
  let scanTimer = null;
  let timerInterval = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const normalize = (value) =>
    String(value ?? "")
      .normalize("NFC")
      .trim()
      .toLowerCase();

  const deepCopy = (value) => JSON.parse(JSON.stringify(value));
  const formatCount = (value) => Number(value ?? 0).toLocaleString("en-US");

  function hueFor(value) {
    let hash = 0;
    for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) % 360;
    return hash;
  }

  function initialsFor(value) {
    return value
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join("");
  }

  function formatHours(minutes) {
    if (minutes == null) return null;
    if (minutes < 60) return `${minutes} min`;
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  }

  function formatPlaytime(minutes) {
    if (minutes == null) return "Unknown";
    if (minutes === 0) return "Never played";
    return formatHours(minutes);
  }

  function formatHoursShort(minutes) {
    return formatHours(minutes) ?? "?";
  }

  function formatBytes(bytes) {
    if (bytes == null) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
  }

  function parseDate(value) {
    return value ? new Date(`${value}T00:00:00Z`) : null;
  }

  function relativeDate(value) {
    const date = parseDate(value);
    if (!date) return "Never";
    const days = Math.floor((TODAY - date) / 86_400_000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 30) return `${days} days ago`;
    if (days < 365) return `${Math.floor(days / 30)} mo ago`;
    return `${Math.floor(days / 365)} yr ago`;
  }

  function reviewTone(score) {
    if (score == null) return "none";
    if (score >= 95) return "great";
    if (score >= 85) return "good";
    if (score >= 70) return "mixed";
    return "bad";
  }

  function ownershipLabel(value) {
    if (value === "local_only") return "Local only";
    if (value === "unknown") return "Unknown";
    return "Owned";
  }

  function installLabel(value) {
    if (value === true) return "Installed";
    if (value === false) return "Not installed";
    return "Install state unknown";
  }

  function coverUrl(appId) {
    return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
  }

  function headerUrl(appId) {
    return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
  }

  function gameById(appId) {
    return GAMES.find((entry) => entry.appId === Number(appId)) ?? null;
  }

  function libraryGames() {
    if (["first-run", "loading", "empty"].includes(state.scenario)) return [];
    return GAMES;
  }

  function savedSmart() {
    return SMART_COLLECTIONS.find((entry) => entry.id === state.activeSmartId) ?? null;
  }

  function steamCollectionById(id) {
    return STEAM_COLLECTIONS.find((entry) => entry.id === id) ?? null;
  }

  function currentSteam() {
    return steamCollectionById(state.activeSteamId);
  }

  function isSmartDirty() {
    if (state.view !== "smart") return false;
    if (state.draft) return true;
    const saved = savedSmart();
    if (!saved) return true;
    return (
      state.editorName.trim() !== saved.name ||
      JSON.stringify(state.editorRules) !== JSON.stringify(saved.rules)
    );
  }

  function loadSmart(id) {
    const collection = SMART_COLLECTIONS.find((entry) => entry.id === id);
    if (!collection) return;
    state.activeSmartId = id;
    state.draft = null;
    state.editorName = collection.name;
    state.editorRules = deepCopy(collection.rules);
    state.dirty = false;
    state.gamePicker = null;
  }

  /* ---------- Rule evaluation, straight from the v1 grammar ---------- */

  function readField(rule, entry) {
    switch (rule.field) {
      case "name":
        return entry.name;
      case "playtime":
        return entry.playtime;
      case "installed":
        return entry.installed;
      case "ownershipStatus":
        return entry.ownership;
      case "lastPlayed":
        return entry.lastPlayed;
      case "releaseYear":
        return entry.releaseYear;
      case "metacriticScore":
        return entry.metacritic;
      case "reviewScore":
        return entry.reviewScore;
      case "reviewTier":
        return entry.reviewTier;
      case "reviewCount":
        return entry.reviewCount;
      case "storefrontType":
        return entry.type;
      case "platform":
        return entry.platforms;
      case "genre":
        return entry.genres;
      case "category":
        return entry.categories;
      case "developer":
        return entry.developers;
      case "publisher":
        return entry.publishers;
      case "tag":
        return entry.tags.map((tag) => tag[0]);
      case "steamCollection":
        return entry.steamCollections;
      case "game":
        return entry.appId;
      default:
        return null;
    }
  }

  function compareValues(actual, expected) {
    if (typeof actual === "number" && typeof expected === "number") return actual - expected;
    if (typeof actual === "string" && typeof expected === "string") {
      return actual.localeCompare(expected);
    }
    return null;
  }

  function testRule(rule, entry) {
    const actual = readField(rule, entry);
    if (actual == null) return false;

    switch (rule.operator) {
      case "is":
        if (typeof actual === "boolean") return actual === rule.value;
        return normalize(actual) === normalize(rule.value);
      case "contains":
        return normalize(actual).includes(normalize(rule.value));
      case "has":
        if (!Array.isArray(actual)) return false;
        return actual.some((item) =>
          rule.field === "steamCollection"
            ? item === rule.value
            : normalize(item) === normalize(rule.value),
        );
      case "in":
        return Array.isArray(rule.value) && rule.value.includes(entry.appId);
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const comparison = compareValues(actual, rule.value);
        if (comparison == null) return false;
        if (rule.operator === "lt") return comparison < 0;
        if (rule.operator === "lte") return comparison <= 0;
        if (rule.operator === "gt") return comparison > 0;
        return comparison >= 0;
      }
      default:
        return false;
    }
  }

  function evaluateRules(rules, games) {
    return games.filter((entry) => {
      for (const rule of rules) {
        if (rule.prefix === "AND" && !testRule(rule, entry)) return false;
      }

      const orRules = rules.filter((rule) => rule.prefix === "OR");
      if (orRules.length > 0 && !orRules.some((rule) => testRule(rule, entry))) {
        return false;
      }

      for (const rule of rules) {
        if (rule.prefix === "NOT" && testRule(rule, entry)) return false;
      }

      return true;
    });
  }

  function validateRule(rule) {
    const definition = FIELDS[rule.field];
    if (!definition) return "Unknown field.";
    if (!definition.operators.includes(rule.operator)) {
      return `${definition.label} does not accept “${rule.operator}”.`;
    }

    const value = rule.value;

    switch (definition.kind) {
      case "text":
      case "ref":
      case "open-enum":
        if (typeof value !== "string" || value.trim() === "") return "Choose a value.";
        return null;
      case "enum":
        if (typeof value !== "string" || !definition.values.includes(value)) {
          return "Choose a value.";
        }
        return null;
      case "boolean":
        if (typeof value !== "boolean") return "Choose installed or not installed.";
        return null;
      case "steamCollection":
        if (typeof value !== "string" || value === "") return "Choose a Steam Collection.";
        return null;
      case "games":
        if (!Array.isArray(value) || value.length === 0) return "Pick at least one game.";
        if (value.length > 1000) return "Pick 1,000 games at most.";
        if (new Set(value).size !== value.length) return "A game is picked twice.";
        if (value.some((id) => !Number.isInteger(id) || id <= 0)) return "Invalid App ID.";
        return null;
      case "date":
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return "Choose a date.";
        }
        {
          const [year, month, day] = value.split("-").map(Number);
          const parsed = new Date(Date.UTC(year, month - 1, day));
          if (
            parsed.getUTCFullYear() !== year ||
            parsed.getUTCMonth() !== month - 1 ||
            parsed.getUTCDate() !== day
          ) {
            return "Choose a real date.";
          }
        }
        return null;
      case "hours":
        if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number.";
        if (!Number.isInteger(value) || value < 0) return "Enter whole minutes or more.";
        return null;
      case "number":
      case "score": {
        if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number.";
        if (!Number.isInteger(value)) return "Enter a whole number.";
        if (definition.kind === "score" && (value < 0 || value > 100)) return "Use 0–100.";
        if (rule.field === "releaseYear" && (value < 1000 || value > 9999)) {
          return "Use a four-digit year.";
        }
        if (rule.field === "reviewCount" && value < 0) return "Use zero or more.";
        return null;
      }
      default:
        return null;
    }
  }

  function describeRule(rule) {
    const definition = FIELDS[rule.field];
    if (!definition) return "Unknown rule";
    const operator = {
      lt: "<",
      lte: "≤",
      gt: ">",
      gte: "≥",
      is: "is",
      contains: "contains",
      has: "has",
      in: "in",
    }[rule.operator];

    switch (rule.field) {
      case "playtime":
        return `Playtime ${operator} ${formatHoursShort(rule.value)}`;
      case "installed":
        return rule.value === true ? "Installed" : "Not installed";
      case "tag":
        return rule.value ? `Tagged “${rule.value}”` : "Tag · choose a value";
      case "steamCollection": {
        const collection = steamCollectionById(rule.value);
        if (!collection) return "Unknown Steam Collection · matches nothing";
        if (collection.isDynamic) return `Dynamic “${collection.name}” · matches nothing`;
        return `In “${collection.name}”`;
      }
      case "game": {
        const count = Array.isArray(rule.value) ? rule.value.length : 0;
        return count === 0
          ? "Game list · none yet"
          : `${count} game${count === 1 ? "" : "s"} picked`;
      }
      case "lastPlayed":
        return `Last played ${operator} ${rule.value || "…"}`;
      case "reviewScore":
        return `Review score ${operator} ${rule.value ?? "…"}%`;
      case "reviewTier":
        return `Review tier is “${rule.value || "…"}”`;
      case "ownershipStatus":
        return `Ownership is “${ownershipLabel(rule.value)}”`;
      case "name":
        return `Name ${operator} “${rule.value || "…"}”`;
      case "releaseYear":
        return `Released ${operator} ${rule.value ?? "…"}`;
      case "metacriticScore":
        return `Metacritic ${operator} ${rule.value ?? "…"}`;
      case "reviewCount":
        return `Reviews ${operator} ${formatCount(rule.value ?? 0)}`;
      case "storefrontType":
        return `Storefront type is “${rule.value || "…"}”`;
      case "platform":
        return `Platform has “${rule.value || "…"}”`;
      default:
        return `${definition.label} ${operator} ${String(rule.value ?? "…")}`;
    }
  }

  /* ---------- Data helpers ---------- */

  function sortGames(list) {
    const direction = state.order === "asc" ? 1 : -1;
    const read = (entry) => {
      switch (state.sort) {
        case "playtime":
          return entry.playtime;
        case "lastPlayed":
          return entry.lastPlayed;
        case "releaseYear":
          return entry.releaseYear;
        case "metacritic":
          return entry.metacritic;
        case "appId":
          return entry.appId;
        default:
          return entry.name;
      }
    };

    return list.sort((left, right) => {
      const a = read(left);
      const b = read(right);
      if (a == null && b == null) return left.appId - right.appId;
      if (a == null) return 1;
      if (b == null) return -1;
      if (typeof a === "string" && typeof b === "string") {
        return (
          a.localeCompare(b, undefined, { sensitivity: "base" }) * direction ||
          left.appId - right.appId
        );
      }
      return (a - b) * direction || left.appId - right.appId;
    });
  }

  function baseGames() {
    let list;
    if (state.view === "smart") {
      list = evaluateRules(state.editorRules, libraryGames());
    } else if (state.view === "steam") {
      const collection = currentSteam();
      list =
        collection && !collection.isDynamic
          ? libraryGames().filter((entry) => entry.steamCollections.includes(collection.id))
          : [];
    } else if (state.view === "installed") {
      list = libraryGames().filter((entry) => entry.installed === true);
    } else {
      list = libraryGames().slice();
    }

    if (state.installedOnly && state.view !== "installed") {
      list = list.filter((entry) => entry.installed === true);
    }

    return list;
  }

  function visibleGames() {
    let list = baseGames();
    const query = normalize(state.search);
    if (query) {
      list = list.filter((entry) => normalize(entry.name).includes(query));
    }
    return sortGames(list);
  }

  function selectedGames() {
    return GAMES.filter((entry) => state.selected.has(entry.appId));
  }

  function fieldValues(ref) {
    const counts = new Map();
    for (const entry of GAMES) {
      const values = Array.isArray(entry[ref])
        ? entry[ref].map((item) => (Array.isArray(item) ? item[0] : item))
        : [];
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return Array.from(counts, ([value, count]) => ({ value, count })).sort(
      (a, b) => b.count - a.count || a.value.localeCompare(b.value),
    );
  }

  function smartMatchCount(collection) {
    return evaluateRules(collection.rules, libraryGames()).length;
  }

  function prefixCounts(rules) {
    return {
      AND: rules.filter((rule) => rule.prefix === "AND").length,
      OR: rules.filter((rule) => rule.prefix === "OR").length,
      NOT: rules.filter((rule) => rule.prefix === "NOT").length,
    };
  }
  /* ---------- Markup helpers ---------- */

  const PATHS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    warning: '<path d="M12 4 3 20h18L12 4Z"/><path d="M12 9v5M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8h.01"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    refresh: '<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    table: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    gamepad:
      '<path d="M7 8h10a5 5 0 0 1 4.9 6l-.6 3a2.4 2.4 0 0 1-4.1 1.2L15 16H9l-2.2 2.2A2.4 2.4 0 0 1 2.7 17l-.6-3A5 5 0 0 1 7 8Z"/><path d="M7 11v4M5 13h4M16 12h.01M18 14h.01"/>',
    folder:
      '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
    sparkle:
      '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
    timer: '<circle cx="12" cy="13" r="7"/><path d="M12 9v4l3 2M9 3h6"/>',
    arrowUp: '<path d="M12 20V4M12 4 5 11M12 4l7 7"/>',
  };

  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;

  const catMark = `
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M6 14 4 5l8 5a12 12 0 0 1 8 0l8-5-2 9v6a9 9 0 0 1-9 9h-2a9 9 0 0 1-9-9Z" />
      <path d="M11 16h.01M21 16h.01M12 22c2 1 6 1 8 0" />
    </svg>`;

  function renderAll() {
    renderSidebar();
    renderTopbar();
    renderBanner();
    renderSelectionBar();
    renderContent();
    renderScenarioSelect();
    renderTimerButton();
    renderProtoBar();
    wireCoverFallbacks();
    applyFocus();
  }

  function renderProtoBar() {
    const bar = $(".proto-bar");
    if (!bar) return;
    bar.classList.toggle("is-open", state.protoOpen);
    const toggle = $("[data-action='toggle-proto']");
    if (toggle) toggle.setAttribute("aria-expanded", String(state.protoOpen));
  }

  function renderScenarioSelect() {
    const select = $("#scenario");
    if (select) select.value = state.scenario;
  }

  function applyFocus() {
    if (state.focusMain) {
      state.focusMain = false;
      const content = $("#content");
      if (content) content.focus({ preventScroll: true });
    }

    if (state.focusAfterRender) {
      const { selector, atEnd = false, select = false } = state.focusAfterRender;
      state.focusAfterRender = null;
      const element = $(selector);
      if (element) {
        element.focus({ preventScroll: true });
        if (select && typeof element.select === "function") element.select();
        else if (atEnd && typeof element.setSelectionRange === "function") {
          element.setSelectionRange(element.value.length, element.value.length);
        }
      }
    }
  }

  function mirrorSearchInput() {
    const input = $("#search");
    if (input && input.value !== state.search) input.value = state.search;
    const clear = $("#search-clear");
    if (clear) clear.hidden = state.search.length === 0;
  }

  /* ---------- Sidebar ---------- */

  function countText(value) {
    return ["first-run", "loading"].includes(state.scenario) ? "—" : formatCount(value);
  }

  function renderSidebar() {
    const sidebar = $("#sidebar");
    if (!sidebar) return;

    const library = libraryGames();
    const installed = library.filter((entry) => entry.installed === true).length;
    const locked = ["first-run", "loading"].includes(state.scenario);
    const activeSmart = state.view === "smart";
    const activeSteam = state.view === "steam";

    const smartItems = SMART_COLLECTIONS.map((collection) => {
      const isActive = activeSmart && state.activeSmartId === collection.id && !state.draft;
      return `
        <button class="side-item ${isActive ? "is-active" : ""}" data-action="open-smart" data-id="${collection.id}" ${locked ? "disabled" : ""}>
          ${icon("sparkle")}
          <span class="label">${escapeHtml(collection.name)}</span>
          <span class="count">${countText(smartMatchCount(collection))}</span>
        </button>`;
    }).join("");

    const draftItem = state.draft
      ? `
        <button class="side-item is-active" data-action="open-draft" ${locked ? "disabled" : ""}>
          ${icon("sparkle")}
          <span class="label">${escapeHtml(state.editorName || "Untitled collection")}</span>
          <span class="draft-dot" aria-label="Unsaved draft"></span>
        </button>`
      : "";

    const noSmarts = SMART_COLLECTIONS.length === 0 && !state.draft;

    const steamItems = STEAM_COLLECTIONS.map((collection) => {
      const isActive = activeSteam && state.activeSteamId === collection.id;
      const memberCount = library.filter((entry) =>
        entry.steamCollections.includes(collection.id),
      ).length;
      return `
        <button class="side-item ${isActive ? "is-active" : ""}" data-action="open-steam" data-id="${collection.id}" ${locked ? "disabled" : ""}>
          ${icon("gamepad")}
          <span class="label">${escapeHtml(collection.name)}</span>
          <span class="count">${collection.isDynamic ? "dynamic" : countText(memberCount)}</span>
        </button>`;
    }).join("");

    let refreshLabel = "Library up to date";
    let refreshTone = "green";
    if (state.scenario === "first-run") {
      refreshLabel = "Not connected";
      refreshTone = "muted";
    } else if (state.scenario === "loading") {
      refreshLabel = "Reading library";
      refreshTone = "busy";
    } else if (state.scenario === "empty") {
      refreshLabel = "No games found";
      refreshTone = "muted";
    } else if (state.scenario === "refreshing") {
      refreshLabel = "Refreshing metadata";
      refreshTone = "busy";
    } else if (state.scenario === "error") {
      refreshLabel = "Ownership incomplete";
      refreshTone = "warn";
    }

    const refreshIcon =
      refreshTone === "busy"
        ? '<span class="spinner" aria-hidden="true"></span>'
        : `<span class="status-dot" style="background: ${refreshTone === "warn" ? "var(--orange)" : refreshTone === "muted" ? "var(--text-faint)" : "var(--green)"}"></span>`;

    let refreshMeta;
    if (state.scenario === "first-run") {
      refreshMeta = "No library scanned yet";
    } else if (state.scenario === "loading") {
      refreshMeta = "Reading app manifests…";
    } else if (state.scenario === "empty") {
      refreshMeta = "No games found · check library folders";
    } else {
      refreshMeta = `${countText(library.length)} games · ${countText(installed)} installed<br />Metadata checked 3 h ago`;
    }

    const account =
      state.scenario === "first-run"
        ? `<div class="account"><div class="avatar">?</div><div><div class="account-name">No account connected</div><div class="account-meta">Local data only</div></div></div>`
        : `<div class="account"><div class="avatar">P</div><div><div class="account-name">Player</div><div class="account-meta">Steam · 7656119…</div></div></div>`;

    sidebar.innerHTML = `
      <div class="brand">
        <div class="brand-mark">${catMark}</div>
        <span class="brand-name">game-cat</span>
        <span class="brand-version">v1 proto</span>
        <button class="icon-btn sidebar-close" data-action="close-sidebar" aria-label="Close navigation">${icon("x")}</button>
      </div>

      <div class="side-section">
        <div class="side-list">
          <button class="side-item ${state.view === "library" ? "is-active" : ""}" data-action="view-library" ${locked ? "disabled" : ""}>
            ${icon("grid")}
            <span class="label">All games</span>
            <span class="count">${countText(library.length)}</span>
          </button>
          <button class="side-item ${state.view === "installed" ? "is-active" : ""}" data-action="view-installed" ${locked ? "disabled" : ""}>
            ${icon("check")}
            <span class="label">Installed</span>
            <span class="count">${countText(installed)}</span>
          </button>
        </div>
      </div>

      <div class="side-section">
        <div class="side-heading">
          <span>Smart Collections</span>
          <button class="icon-btn" data-action="new-collection" aria-label="New Smart Collection" ${locked ? "disabled" : ""}>${icon("plus")}</button>
        </div>
        <div class="side-list">${draftItem}${smartItems}</div>
        ${noSmarts ? `<p class="side-empty">No Smart Collections yet. <button data-action="new-collection">Create one</button></p>` : ""}
      </div>

      <div class="side-section">
        <div class="side-heading">
          <span>Steam Collections</span>
          <span class="readonly-note" title="Read-only in v1">${icon("lock")}</span>
        </div>
        <div class="side-list">${steamItems}</div>
        <p class="readonly-note">Read-only mirror · never written back</p>
      </div>

      <div class="sidebar-foot">
        <div class="status-card">
          <div class="status-line">${refreshIcon}<span class="js-refresh-label">${refreshLabel}</span></div>
          <div class="status-meta">${refreshMeta}</div>
          <button class="ghost status-btn" data-action="refresh" ${state.scenario === "first-run" || state.scenario === "loading" || state.scenario === "refreshing" ? "disabled" : ""}>
            ${icon("refresh")} ${state.scenario === "refreshing" ? "Refreshing…" : "Refresh all"}
          </button>
        </div>
        ${account}
      </div>`;
  }

  /* ---------- Topbar ---------- */

  function computeCrumb() {
    const library = libraryGames();
    const installed = library.filter((entry) => entry.installed === true).length;

    if (state.scenario === "first-run") {
      return { kicker: "Setup", title: "Connect your library", sub: "Read-only, local-first" };
    }
    if (state.scenario === "loading") {
      return {
        kicker: "Library",
        title: "Reading Steam files",
        sub: "This usually takes a few seconds",
      };
    }
    if (state.scenario === "empty") {
      return { kicker: "Library", title: "All games", sub: "0 games" };
    }
    if (state.view === "smart") {
      const matches = evaluateRules(state.editorRules, library).length;
      const ruleCount = state.editorRules.length;
      return {
        kicker: state.draft ? "Smart Collection · draft" : "Smart Collection",
        title: state.editorName.trim() || "Untitled collection",
        sub: `${ruleCount} rule${ruleCount === 1 ? "" : "s"} · ${formatCount(matches)} match${matches === 1 ? "" : "es"}`,
      };
    }
    if (state.view === "steam") {
      const collection = currentSteam();
      const count = collection
        ? library.filter((entry) => entry.steamCollections.includes(collection.id)).length
        : 0;
      return {
        kicker: "Steam Collection",
        title: collection?.name ?? "Steam Collection",
        sub: collection?.isDynamic
          ? "Dynamic · not mirrored"
          : `${formatCount(count)} games · read-only`,
      };
    }
    if (state.view === "installed") {
      return {
        kicker: "Library",
        title: "Installed",
        sub: `${formatCount(installed)} of ${formatCount(library.length)} games`,
      };
    }
    return {
      kicker: "Library",
      title: "All games",
      sub: `${formatCount(library.length)} games · ${formatCount(installed)} installed`,
    };
  }

  function updateCrumb() {
    const crumb = computeCrumb();
    const kicker = $("#crumb-kicker");
    const title = $("#crumb-title");
    const sub = $("#crumb-sub");
    if (kicker) kicker.textContent = crumb.kicker;
    if (title) title.textContent = crumb.title;
    if (sub) sub.textContent = crumb.sub;
  }

  function renderTopbar() {
    const crumb = computeCrumb();
    updateCrumb();
    document.body.classList.toggle(
      "is-setup",
      state.scenario === "first-run" || state.scenario === "loading",
    );

    const search = $("#search");
    const locked = ["first-run", "loading"].includes(state.scenario);
    if (search) {
      search.disabled = locked;
      search.placeholder = state.view === "smart" ? "Search within matches" : "Search game names";
    }
    mirrorSearchInput();

    const sort = $("#sort");
    if (sort) {
      sort.value = state.sort;
      sort.disabled = locked;
    }

    const order = $("#order");
    if (order) {
      order.classList.toggle("is-desc", state.order === "desc");
      order.setAttribute(
        "aria-label",
        state.order === "asc" ? "Sort ascending" : "Sort descending",
      );
      order.disabled = locked;
    }

    const installedFilter = $("#installed-filter");
    if (installedFilter) {
      installedFilter.setAttribute("aria-pressed", String(state.installedOnly));
      installedFilter.disabled = locked;
    }

    $$("[data-action='set-layout']").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.layout === state.layout));
    });

    $$("[data-action='new-collection']").forEach((button) => {
      button.disabled = locked;
    });

    document.title = `${crumb.title} · game-cat prototype`;
  }

  /* ---------- Banners and selection ---------- */

  function renderBanner() {
    const root = $("#banner-root");
    if (!root) return;

    if (state.scenario === "loading") {
      root.innerHTML = `
        <div class="banner is-info" role="status">
          <div class="banner-icon"><span class="spinner"></span></div>
          <div class="banner-body">
            <div class="banner-title">Reading Steam library</div>
            <div class="banner-text">Parsing app manifests and local playtime. Nothing is written to Steam.</div>
            <div class="progress is-indeterminate"><span></span></div>
          </div>
        </div>`;
      return;
    }

    if (state.scenario === "refreshing") {
      const percent = Math.round((state.refresh.done / state.refresh.total) * 100);
      root.innerHTML = `
        <div class="banner is-warning" role="status">
          <div class="banner-icon"><span class="spinner"></span></div>
          <div class="banner-body">
            <div class="banner-title">Refreshing metadata · <span data-refresh-count>${state.refresh.done} of ${state.refresh.total}</span></div>
            <div class="banner-text">The library stays usable while this runs. SteamSpy and the storefront are rate limited to roughly one request per second.</div>
            <div class="progress"><span data-refresh-bar style="width: ${percent}%"></span></div>
          </div>
          <div class="banner-actions">
            <button class="ghost" data-action="refresh-details">Why so slow?</button>
          </div>
        </div>`;
      return;
    }

    if (state.scenario === "error") {
      const owned = libraryGames().filter((entry) => entry.ownership === "owned").length;
      const local = libraryGames().filter((entry) => entry.ownership === "local_only").length;
      const unknown = libraryGames().filter((entry) => entry.ownership === "unknown").length;
      root.innerHTML = `
        <div class="banner is-danger" role="alert">
          <div class="banner-icon" style="color: var(--red)">${icon("warning")}</div>
          <div class="banner-body">
            <div class="banner-title">Ownership refresh failed</div>
            <div class="banner-text">
              The Steam Web API rejected the key. ${formatCount(owned)} games are confirmed owned;
              ${formatCount(local)} are local-only and ${formatCount(unknown)} unknown. Local files and
              Steam Collections still work.
            </div>
          </div>
          <div class="banner-actions">
            <button class="ghost" data-action="fix-key">Fix API key</button>
            <button class="secondary" data-action="retry-ownership">Retry</button>
          </div>
        </div>`;
      return;
    }

    root.innerHTML = "";
  }

  function renderSelectionBar() {
    const root = $("#selection-root");
    if (!root) return;
    const count = state.selected.size;
    if (count === 0) {
      root.innerHTML = "";
      return;
    }

    root.innerHTML = `
      <div class="selection-bar">
        <span class="selection-count">${formatCount(count)} selected</span>
        <span class="results-count">Make a game list from these games.</span>
        <div class="selection-actions">
          <button class="ghost" data-action="clear-selection">Clear</button>
          ${state.view === "smart" ? `<button class="secondary" data-action="add-selection-to-rules">Add to current rules</button>` : ""}
          <button class="primary" data-action="new-from-selection">${icon("plus")} New from selection</button>
        </div>
      </div>`;
  }

  /* ---------- Content and results ---------- */

  function renderContent() {
    const root = $("#content-root");
    if (!root) return;

    if (state.scenario === "first-run") {
      root.innerHTML = renderOnboarding();
      return;
    }

    if (state.scenario === "loading") {
      root.innerHTML = renderSkeleton();
      return;
    }

    if (state.scenario === "empty") {
      root.innerHTML = renderEmptyLibrary();
      return;
    }

    if (state.view === "smart") {
      root.innerHTML = `
        <div class="smart-layout">
          <section class="results-pane" aria-label="Matching games">
            <div id="results-head"></div>
            <div id="results-root"></div>
          </section>
          ${renderEditor()}
        </div>`;
      renderResults();
      return;
    }

    const steamNote = state.view === "steam" ? renderSteamNote() : "";

    root.innerHTML = `
      ${steamNote}
      <div id="results-head"></div>
      <div id="results-root"></div>`;
    renderResults();
  }

  function renderSteamNote() {
    const collection = currentSteam();
    if (!collection) return "";
    if (collection.isDynamic) {
      return `
        <div class="steam-note">
          ${icon("info")}
          <span>Dynamic Steam Collection. Steam computes its membership; game-cat does not mirror it in v1.</span>
        </div>`;
    }
    return `
      <div class="steam-note">
        ${icon("lock")}
        <span>Read-only mirror of a Steam Collection. game-cat never writes it back.</span>
        <span class="spacer"></span>
        <button class="ghost" data-action="new-from-steam">${icon("plus")} Use in a Smart Collection</button>
      </div>`;
  }

  function renderResultsHead() {
    const root = $("#results-head");
    if (!root) return;

    const games = visibleGames();
    const total = baseGames().length;
    const filtered = state.search.trim() !== "" || state.installedOnly;
    const allSelected = games.length > 0 && games.every((entry) => state.selected.has(entry.appId));

    let label;
    if (state.view === "smart") {
      label = `<strong>${formatCount(total)}</strong> match${total === 1 ? "" : "es"}`;
    } else if (state.view === "steam") {
      label = `<strong>${formatCount(total)}</strong> game${total === 1 ? "" : "s"}`;
    } else {
      label = `<strong>${formatCount(games.length)}</strong> game${games.length === 1 ? "" : "s"}`;
    }

    if (filtered && state.view !== "smart" && games.length !== total) {
      label += ` · ${formatCount(games.length)} shown`;
    } else if (filtered && state.view === "smart" && games.length !== total) {
      label += ` · ${formatCount(games.length)} shown`;
    }

    root.innerHTML = `
      <div class="results-head">
        <span class="results-count" aria-live="polite">${label}</span>
        <div class="results-actions">
          ${
            games.length > 0
              ? `<button class="ghost" data-action="select-visible" ${allSelected ? "disabled" : ""}>${allSelected ? "All shown selected" : "Select shown"}</button>`
              : ""
          }
          ${state.selected.size > 0 ? `<button class="ghost" data-action="clear-selection">Clear selection</button>` : ""}
        </div>
      </div>`;
  }

  function renderResults() {
    renderResultsHead();
    const root = $("#results-root");
    if (!root) return;

    const games = visibleGames();
    state.lastVisibleIds = games.map((entry) => entry.appId);

    if (games.length === 0) {
      root.innerHTML = renderEmptyResults();
      return;
    }

    root.innerHTML = state.layout === "grid" ? renderGrid(games) : renderTable(games);
    wireCoverFallbacks(root);
  }

  function renderGrid(games) {
    return `
      <div class="game-grid">
        ${games
          .map((entry) => {
            const selected = state.selected.has(entry.appId);
            const tone = reviewTone(entry.reviewScore);
            const tags = entry.tags
              .slice(0, 2)
              .map((tag) => escapeHtml(tag[0]))
              .join(" · ");
            const ownership =
              entry.ownership === "owned"
                ? ""
                : `<span class="ownership-flag ${entry.ownership === "unknown" ? "unknown" : ""}">${escapeHtml(ownershipLabel(entry.ownership))}</span>`;
            return `
              <article class="game-card ${selected ? "is-selected" : ""}">
                <div class="card-open" role="button" tabindex="0" data-action="open-game" data-appid="${entry.appId}" aria-label="${escapeHtml(entry.name)}, ${formatPlaytime(entry.playtime)}, ${installLabel(entry.installed)}">
                  <div class="cover" style="--cover-h: ${hueFor(entry.name)}">
                    <div class="cover-fallback">${escapeHtml(initialsFor(entry.name))}</div>
                    <img src="${coverUrl(entry.appId)}" alt="" loading="lazy" data-cover data-appid="${entry.appId}" />
                    <div class="cover-top">
                      ${
                        entry.installed === true
                          ? `<span class="installed-pill"><span class="status-dot"></span>Installed</span>`
                          : entry.installed === null
                            ? `<span class="installed-pill is-unknown">Unknown</span>`
                            : "<span></span>"
                      }
                      ${
                        entry.reviewScore == null
                          ? ""
                          : `<span class="review-pill ${tone}" title="${escapeHtml(entry.reviewTier ?? "")}">${entry.reviewScore}%</span>`
                      }
                    </div>
                  </div>
                  <div class="card-body">
                    <span class="card-title">${escapeHtml(entry.name)}</span>
                    <div class="card-meta">
                      <span>${formatPlaytime(entry.playtime)}</span>
                      ${ownership}
                    </div>
                    <div class="card-tags">${tags || "No tags yet"}</div>
                  </div>
                </div>
                <label class="select-check">
                  <input type="checkbox" data-select-game="${entry.appId}" ${selected ? "checked" : ""} aria-label="Select ${escapeHtml(entry.name)}" />
                </label>
              </article>`;
          })
          .join("")}
      </div>`;
  }

  function renderTable(games) {
    const allSelected = games.length > 0 && games.every((entry) => state.selected.has(entry.appId));
    const sortableHeader = (label, field) => {
      const active = state.sort === field;
      const ariaSort = active ? (state.order === "asc" ? "ascending" : "descending") : "none";
      const arrow = active
        ? `<span class="th-arrow ${state.order === "desc" ? "is-desc" : ""}">${icon("arrowUp")}</span>`
        : "";
      return `<th aria-sort="${ariaSort}"><button class="th-sort" data-action="sort-column" data-sort="${field}">${label}${arrow}</button></th>`;
    };
    return `
      <div class="table-wrap">
        <table class="game-table">
          <thead>
            <tr>
              <th class="col-check"><input type="checkbox" data-select-all ${allSelected ? "checked" : ""} aria-label="Select all shown games" /></th>
              ${sortableHeader("Game", "name")}
              <th>Installed</th>
              ${sortableHeader("Playtime", "playtime")}
              ${sortableHeader("Last played", "lastPlayed")}
              <th>Review</th>
              ${sortableHeader("Released", "releaseYear")}
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            ${games
              .map((entry) => {
                const selected = state.selected.has(entry.appId);
                const tone = reviewTone(entry.reviewScore);
                const tags = entry.tags
                  .slice(0, 3)
                  .map((tag) => escapeHtml(tag[0]))
                  .join(", ");
                return `
                  <tr class="${selected ? "is-selected" : ""}">
                    <td><input type="checkbox" data-select-game="${entry.appId}" ${selected ? "checked" : ""} aria-label="Select ${escapeHtml(entry.name)}" /></td>
                    <td>
                      <button class="table-game" data-action="open-game" data-appid="${entry.appId}">
                        <img class="table-thumb" src="${coverUrl(entry.appId)}" alt="" loading="lazy" data-cover data-appid="${entry.appId}" />
                        <span>
                          <span class="table-game-name">${escapeHtml(entry.name)}</span>
                          <span class="table-game-sub">${escapeHtml(entry.developers[0] ?? "")}${entry.ownership !== "owned" ? ` · ${escapeHtml(ownershipLabel(entry.ownership))}` : ""}</span>
                        </span>
                      </button>
                    </td>
                    <td>${entry.installed === true ? "Yes" : entry.installed === false ? "No" : "Unknown"}</td>
                    <td class="mono">${formatPlaytime(entry.playtime)}</td>
                    <td>${escapeHtml(relativeDate(entry.lastPlayed))}</td>
                    <td class="mono ${entry.reviewScore == null ? "" : `review-text ${tone}`}">${entry.reviewScore == null ? "—" : `${entry.reviewScore}%`}</td>
                    <td class="mono">${entry.releaseYear ?? "—"}</td>
                    <td>${tags || "—"}</td>
                  </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>`;
  }

  function renderEmptyResults() {
    const query = state.search.trim();

    if (query) {
      return `
        <div class="empty-state" role="status">
          <div class="empty-icon">${icon("search")}</div>
          <h2>No games match “${escapeHtml(query)}”</h2>
          <p>Search looks at game names only. Tags, genres, and playtime belong in Rules.</p>
          <div class="empty-actions">
            <button class="secondary" data-action="clear-search">Clear search</button>
          </div>
        </div>`;
    }

    if (state.view === "smart") {
      const hasRules = state.editorRules.length > 0;
      return `
        <div class="empty-state" role="status">
          <div class="empty-icon">${icon("sparkle")}</div>
          <h2>No games match these rules</h2>
          <p>That's allowed, but probably not what you meant. An OR rule widens the result; a NOT rule removes games.</p>
          <div class="empty-actions">
            ${hasRules ? `<button class="secondary" data-action="remove-last-rule">Remove last rule</button>` : ""}
            <button class="ghost" data-action="add-rule" data-field="tag" data-prefix="OR">Add an OR tag rule</button>
          </div>
        </div>`;
    }

    if (state.view === "steam") {
      const dynamic = currentSteam()?.isDynamic;
      return `
        <div class="empty-state" role="status">
          <div class="empty-icon">${icon(dynamic ? "info" : "gamepad")}</div>
          <h2>${dynamic ? "Dynamic collection" : "This Steam Collection is empty"}</h2>
          <p>${dynamic ? "Steam computes this collection's membership. game-cat treats dynamic collections as opaque metadata in v1." : "Steam returned no static members for this collection."}</p>
        </div>`;
    }

    if (state.view === "installed") {
      return `
        <div class="empty-state" role="status">
          <div class="empty-icon">${icon("check")}</div>
          <h2>No installed games</h2>
          <p>Steam's app manifests didn't show any installed games in this library.</p>
        </div>`;
    }

    return `
      <div class="empty-state" role="status">
        <div class="empty-icon">${icon("gamepad")}</div>
        <h2>No games in this view</h2>
        <p>Try clearing the installed filter or search.</p>
        <div class="empty-actions">
          <button class="secondary" data-action="reset-filters">Reset filters</button>
        </div>
      </div>`;
  }

  function wireCoverFallbacks(root = document) {
    $$("img[data-cover]", root).forEach((image) => {
      if (image.dataset.bound === "true") return;
      image.dataset.bound = "true";
      image.addEventListener("error", () => {
        if (image.dataset.stage === "header") {
          image.classList.add("is-broken");
        } else {
          image.dataset.stage = "header";
          image.src = headerUrl(image.dataset.appid);
        }
      });
    });
  }
  /* ---------- Smart Collection editor ---------- */

  function renderEditor() {
    const matches = evaluateRules(state.editorRules, libraryGames()).length;
    const invalid = state.editorRules.filter((rule) => validateRule(rule) !== null).length;
    const nameMissing = state.editorName.trim() === "";
    const dirty = isSmartDirty();

    let statusText = "All changes saved";
    let statusClass = "is-saved";
    if (nameMissing) {
      statusText = "Name required";
      statusClass = "is-invalid";
    } else if (invalid > 0) {
      statusText = `Fix ${invalid} rule${invalid === 1 ? "" : "s"}`;
      statusClass = "is-invalid";
    } else if (dirty) {
      statusText = "Unsaved changes";
      statusClass = "";
    }

    const saveDisabled = nameMissing || invalid > 0 || !dirty;
    const counts = prefixCounts(state.editorRules);

    return `
      <aside class="editor-pane" aria-label="Smart Collection editor">
        <div class="editor-head">
          <div class="editor-kicker">
            <span>${state.draft ? "New Smart Collection" : "Smart Collection"}</span>
            <span class="dirty-state ${statusClass}">${statusText}</span>
          </div>
          <input
            class="collection-name"
            data-collection-name
            value="${escapeHtml(state.editorName)}"
            aria-label="Collection name"
            maxlength="120"
            placeholder="Collection name"
          />
          <div class="editor-head-row">
            <button class="ghost" data-action="revert-collection" ${!dirty ? "disabled" : ""}>Discard</button>
            <button class="primary" data-action="save-collection" ${saveDisabled ? "disabled" : ""}>Save</button>
            <span class="spacer"></span>
            <button class="icon-btn" data-action="delete-collection" aria-label="Delete Smart Collection" ${state.draft ? "disabled" : ""}>${icon("trash")}</button>
          </div>
        </div>

        <div class="match-summary ${matches === 0 ? "is-empty" : ""}" aria-live="polite">
          <strong class="js-match-count">${formatCount(matches)}</strong>
          <span>game${matches === 1 ? "" : "s"} match <span class="js-match-note">· updates as you edit</span></span>
        </div>

        <div class="prefix-note">
          ${icon("info")}
          <div class="prefix-note-text">
            <span class="js-prefix-counts">${counts.AND} AND · ${counts.OR} OR · ${counts.NOT} NOT</span><br />
            Prefixes group globally: every AND must match, at least one OR must match, no NOT may
            match. <strong>They are not evaluated row by row.</strong>
          </div>
        </div>

        <div class="editor-scroll">
          ${
            state.editorRules.length === 0
              ? `<div class="rule-empty"><strong>No rules.</strong><br />This matches all ${formatCount(libraryGames().length)} games. Add a rule to narrow it.</div>`
              : `<ol class="rules-list">${state.editorRules.map(renderRuleRow).join("")}</ol>`
          }

          <div class="add-rule">
            <button class="ghost add-rule-main" data-action="add-rule" data-field="installed">${icon("plus")} Add rule</button>
            <div class="quick-add" aria-label="Quick add rule">
              <button data-action="add-rule" data-field="tag">+ Tag</button>
              <button data-action="add-rule" data-field="playtime">+ Playtime</button>
              <button data-action="add-rule" data-field="steamCollection">+ Steam Collection</button>
              <button data-action="add-rule" data-field="game">+ Game list</button>
            </div>
          </div>
        </div>

        <div class="editor-foot">
          <span class="hint js-save-state">${statusText} · Rules save as a whole array.</span>
          <button class="primary" data-action="save-collection" ${saveDisabled ? "disabled" : ""}>Save</button>
        </div>
        ${renderDatalists()}
      </aside>`;
  }

  function renderRuleRow(rule, index) {
    const definition = FIELDS[rule.field];
    const error = validateRule(rule);
    const operators = definition.operators
      .map(
        (operator) =>
          `<option value="${operator}" ${rule.operator === operator ? "selected" : ""}>${operator}</option>`,
      )
      .join("");
    const fields = Object.entries(FIELDS)
      .map(
        ([key, field]) =>
          `<option value="${key}" ${rule.field === key ? "selected" : ""}>${escapeHtml(field.label)}</option>`,
      )
      .join("");

    return `
      <li class="rule-row prefix-${rule.prefix} ${error ? "is-invalid" : ""}" data-rule-index="${index}">
        <div class="rule-top">
          <div class="prefix-toggle" role="group" aria-label="Rule ${index + 1} prefix">
            ${["AND", "OR", "NOT"]
              .map(
                (prefix) =>
                  `<button data-action="set-prefix" data-index="${index}" data-prefix="${prefix}" aria-pressed="${rule.prefix === prefix}">${prefix}</button>`,
              )
              .join("")}
          </div>
          <span class="rule-desc">${escapeHtml(describeRule(rule))}</span>
          <button class="rule-remove" data-action="remove-rule" data-index="${index}" aria-label="Remove rule ${index + 1}">${icon("x")}</button>
        </div>

        <div class="rule-controls">
          <select class="field-select" data-rule-field="${index}" aria-label="Rule ${index + 1} field">${fields}</select>
          <select class="op-select" data-rule-operator="${index}" aria-label="Rule ${index + 1} operator">${operators}</select>
          ${renderValueControl(rule, index, definition)}
        </div>

        ${state.gamePicker && state.gamePicker.index === index ? renderGamePicker(index) : ""}

        <p class="rule-error" ${error ? "" : "hidden"}>${error ? `${icon("warning")} ${escapeHtml(error)}` : ""}</p>
      </li>`;
  }

  function renderValueControl(rule, index, definition) {
    switch (definition.kind) {
      case "boolean":
        return `
          <div class="boolean-toggle" role="group" aria-label="Rule ${index + 1} value">
            <button data-action="set-boolean" data-index="${index}" data-value="true" aria-pressed="${rule.value === true}">Installed</button>
            <button data-action="set-boolean" data-index="${index}" data-value="false" aria-pressed="${rule.value === false}">Not installed</button>
          </div>`;
      case "enum": {
        const options = definition.values
          .map((value) => {
            const label = rule.field === "ownershipStatus" ? ownershipLabel(value) : value;
            return `<option value="${value}" ${rule.value === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
          })
          .join("");
        return `<select class="value-control" data-rule-value="${index}" data-kind="enum" aria-label="Rule ${index + 1} value">${options}</select>`;
      }
      case "steamCollection": {
        const options = STEAM_COLLECTIONS.map((collection) => {
          const disabled = collection.isDynamic ? "disabled" : "";
          const suffix = collection.isDynamic ? " · dynamic" : "";
          return `<option value="${collection.id}" ${rule.value === collection.id ? "selected" : ""} ${disabled}>${escapeHtml(collection.name)}${suffix}</option>`;
        }).join("");
        return `
          <select class="value-control" data-rule-value="${index}" data-kind="steamCollection" aria-label="Rule ${index + 1} value">
            <option value="" ${rule.value ? "" : "selected"}>Choose a collection…</option>
            ${options}
          </select>`;
      }
      case "date":
        return `<input class="value-control" type="date" data-rule-value="${index}" data-kind="date" value="${escapeHtml(rule.value ?? "")}" aria-label="Rule ${index + 1} value" />`;
      case "hours": {
        const hours = rule.value == null ? "" : Number((rule.value / 60).toFixed(2));
        return `
          <div class="value-control number-wrap">
            <input type="number" min="0" step="0.5" data-rule-value="${index}" data-kind="hours" value="${hours}" aria-label="Rule ${index + 1} value in hours" />
            <span class="suffix">hours</span>
          </div>`;
      }
      case "number":
      case "score": {
        const suffix = definition.suffix ?? (definition.kind === "score" ? "%" : "");
        return `
          <div class="value-control number-wrap">
            <input type="number" step="1" data-rule-value="${index}" data-kind="${definition.kind}" value="${rule.value ?? ""}" aria-label="Rule ${index + 1} value" />
            ${suffix ? `<span class="suffix">${escapeHtml(suffix)}</span>` : ""}
          </div>`;
      }
      case "games": {
        const value = Array.isArray(rule.value) ? rule.value : [];
        const pickerOpen = state.gamePicker?.index === index;
        const chips = value
          .map((appId) => {
            const entry = gameById(appId);
            if (!entry) return "";
            return `
              <span class="game-chip">
                <span>${escapeHtml(entry.name)}</span>
                <button data-action="remove-game" data-index="${index}" data-appid="${appId}" aria-label="Remove ${escapeHtml(entry.name)}">${icon("x")}</button>
              </span>`;
          })
          .join("");
        return `
          <div class="value-control game-value">
            ${chips}
            <button class="pick-games-btn" data-action="toggle-game-picker" data-index="${index}">
              ${value.length === 0 ? "Pick games" : `${value.length} picked · ${pickerOpen ? "done" : "edit"}`}
            </button>
            ${
              pickerOpen
                ? ""
                : `<button class="pick-games-btn" data-action="use-selection" data-index="${index}" ${state.selected.size === 0 ? "disabled" : ""}>Use selection (${state.selected.size})</button>`
            }
          </div>`;
      }
      default: {
        const list =
          definition.kind === "ref"
            ? `dl-ref-${definition.ref}`
            : definition.kind === "open-enum"
              ? `dl-open-${rule.field}`
              : "";
        return `
          <input
            class="value-control"
            type="text"
            data-rule-value="${index}"
            data-kind="text"
            value="${escapeHtml(rule.value ?? "")}"
            ${list ? `list="${list}"` : ""}
            placeholder="${escapeHtml(definition.placeholder ?? "Value")}"
            aria-label="Rule ${index + 1} value"
          />`;
      }
    }
  }

  function renderDatalists() {
    const refs = ["genres", "categories", "developers", "publishers", "tags"];
    const refLists = refs
      .map(
        (ref) => `
          <datalist id="dl-ref-${ref}">
            ${fieldValues(ref)
              .map(
                (item) =>
                  `<option value="${escapeHtml(item.value)}" label="${escapeHtml(item.value)} · ${item.count} game${item.count === 1 ? "" : "s"}"></option>`,
              )
              .join("")}
          </datalist>`,
      )
      .join("");

    const openLists = ["reviewTier", "storefrontType"]
      .map(
        (field) => `
          <datalist id="dl-open-${field}">
            ${(FIELDS[field].values ?? [])
              .map((value) => `<option value="${escapeHtml(value)}"></option>`)
              .join("")}
          </datalist>`,
      )
      .join("");

    return `${refLists}${openLists}`;
  }

  function renderGamePicker(index) {
    const rule = state.editorRules[index];
    const query = normalize(state.gamePicker?.query ?? "");
    const picked = new Set(Array.isArray(rule.value) ? rule.value : []);
    const games = libraryGames()
      .filter((entry) => !query || normalize(entry.name).includes(query))
      .slice()
      .sort((a, b) => {
        const aPicked = picked.has(a.appId) ? 0 : 1;
        const bPicked = picked.has(b.appId) ? 0 : 1;
        return aPicked - bPicked || a.name.localeCompare(b.name);
      });

    const items = games
      .map(
        (entry) => `
          <label class="picker-item">
            <input type="checkbox" data-picker-game="${entry.appId}" data-index="${index}" ${picked.has(entry.appId) ? "checked" : ""} />
            <img src="${coverUrl(entry.appId)}" alt="" loading="lazy" data-cover data-appid="${entry.appId}" />
            <span>${escapeHtml(entry.name)}</span>
          </label>`,
      )
      .join("");

    return `
      <div class="game-picker" data-picker-index="${index}">
        <div class="picker-head">
          <input type="search" data-picker-search value="${escapeHtml(state.gamePicker?.query ?? "")}" placeholder="Find a game…" aria-label="Find a game to add" />
          <button data-action="picker-use-selection" ${state.selected.size === 0 ? "disabled" : ""}>Use selection (${state.selected.size})</button>
          <button data-action="picker-done">Done</button>
        </div>
        <div class="picker-list">
          ${items || `<div class="picker-empty">No game names match that search.</div>`}
        </div>
      </div>`;
  }

  function renderOnboarding() {
    return `
      <section class="onboarding" aria-labelledby="onboarding-title">
        <div class="onboarding-head">
          <div class="onboarding-mark">${catMark}</div>
          <div>
            <h2 id="onboarding-title">Connect your Steam library</h2>
            <p>game-cat reads local Steam files and caches metadata. It never writes to Steam.</p>
          </div>
        </div>
        <div class="onboarding-body">
          <div class="setup-step">
            <span class="step-num">1</span>
            <div>
              <h3>Steam folder</h3>
              <p>We found one library on this machine. Add more later if you use extra drives.</p>
              <div class="field">
                <label for="steam-root">Steam root</label>
                <div class="field-row">
                  <input id="steam-root" type="text" value="/home/you/.local/share/Steam" readonly />
                  <button class="ghost" data-action="browse-folder">${icon("folder")} Browse</button>
                </div>
                <span class="input-ok">${icon("check")} Detected</span>
              </div>
            </div>
          </div>

          <div class="setup-step">
            <span class="step-num">2</span>
            <div>
              <h3>Steam Web API key</h3>
              <p>Required for the full owned-games roster. v1 cannot claim a complete library without it.</p>
              <div class="field">
                <label for="api-key">Web API key</label>
                <div class="field-row">
                  <input id="api-key" type="password" placeholder="Paste your key" autocomplete="off" required aria-required="true" />
                  <a class="ghost" href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer">Get a key ${icon("external")}</a>
                </div>
              </div>
            </div>
          </div>

          <div class="setup-step">
            <span class="step-num">3</span>
            <div>
              <h3>Scan the library</h3>
              <p>The first scan reads app manifests, playtime, and Steam Collections.</p>
              <div class="onboarding-actions">
                <button class="primary" data-action="scan-library">${icon("search")} Scan library</button>
                <span class="hint">~10 seconds for 1,300 games</span>
              </div>
            </div>
          </div>
        </div>
      </section>`;
  }

  function renderSkeleton() {
    return `
      <div class="skeleton-grid" aria-busy="true" aria-label="Loading library">
        ${Array.from({ length: 12 })
          .map(
            (_, index) => `
              <div class="skeleton-card">
                <div class="skeleton-cover shimmer"></div>
                <div class="skeleton-body">
                  <div class="skeleton-line shimmer" style="width: ${70 + (index % 3) * 8}%"></div>
                  <div class="skeleton-line shimmer" style="width: 45%"></div>
                </div>
              </div>`,
          )
          .join("")}
      </div>`;
  }

  function renderEmptyLibrary() {
    return `
      <div class="empty-state">
        <div class="empty-icon">${icon("gamepad")}</div>
        <h2>No games found</h2>
        <p>
          Steam is installed at <code>/home/you/.local/share/Steam</code>, but no app manifests were
          found. Check that the library folders below still exist.
        </p>
        <div class="empty-actions">
          <button class="primary" data-action="scan-library">${icon("refresh")} Scan again</button>
          <button class="ghost" data-action="browse-folder">${icon("folder")} Open folder</button>
        </div>
        <p class="empty-hint">Common causes: a moved Steam library, a Flatpak path, or a fresh Steam install with no games yet.</p>
      </div>`;
  }

  /* ---------- Game detail ---------- */

  function renderDetail() {
    const root = $("#detail-root");
    if (!root) return;
    const entry = gameById(state.drawerAppId);
    if (!entry) {
      root.innerHTML = "";
      return;
    }

    const tone = reviewTone(entry.reviewScore);
    const selected = state.selected.has(entry.appId);
    const tags = entry.tags.slice().sort((a, b) => b[1] - a[1]);
    const collections = entry.steamCollections
      .map((id) => steamCollectionById(id)?.name)
      .filter(Boolean);
    const sourceTone = (status) =>
      status === "ok"
        ? "source-ok"
        : status === "stale" || status === "missing"
          ? "source-warn"
          : "";

    root.innerHTML = `
      <section class="detail-panel" aria-labelledby="detail-title">
        <button class="icon-btn detail-close" data-action="close-detail" aria-label="Close game detail">${icon("x")}</button>
        <div class="detail-banner" style="--cover-h: ${hueFor(entry.name)}">
          <img src="${headerUrl(entry.appId)}" alt="" data-cover data-appid="${entry.appId}" />
          <div class="detail-banner-text">
            <h2 id="detail-title">${escapeHtml(entry.name)}</h2>
            <div class="detail-badges">
              ${
                entry.installed === true
                  ? `<span class="badge is-good"><span class="status-dot"></span>Installed</span>`
                  : entry.installed === false
                    ? `<span class="badge">Not installed</span>`
                    : `<span class="badge">Install unknown</span>`
              }
              <span class="badge ${entry.ownership === "owned" ? "is-good" : "is-warn"}">${escapeHtml(ownershipLabel(entry.ownership))}</span>
              <span class="badge">App ${entry.appId}</span>
            </div>
          </div>
        </div>

        <div class="detail-scroll" tabindex="0" aria-label="Game details">
          <div class="stat-grid">
            ${stat("Playtime", formatPlaytime(entry.playtime), `${formatCount(entry.playtime)} minutes`)}
            ${stat("Last played", relativeDate(entry.lastPlayed), entry.lastPlayed ?? "No record")}
            ${stat("Review", entry.reviewScore == null ? "No summary" : `${entry.reviewScore}%`, entry.reviewTier ?? "Unavailable", entry.reviewScore == null ? "" : `review-text ${tone}`)}
            ${stat("Review count", entry.reviewCount == null ? "Unknown" : formatCount(entry.reviewCount), entry.reviewCount === 0 ? "No reviews" : "Steam user reviews")}
            ${stat("Released", entry.releaseYear ?? "—", entry.type === "game" ? "Game" : entry.type)}
            ${stat("Metacritic", entry.metacritic ?? "—", entry.metacritic == null ? "No score" : "Critic score")}
            ${stat("Size on disk", entry.installed === true && entry.sizeOnDisk != null ? formatBytes(entry.sizeOnDisk) : "—", entry.installed === true ? "Installed" : entry.installed === null ? "Unknown" : "Not on disk")}
            ${stat("Ownership", ownershipLabel(entry.ownership), entry.ownership === "local_only" ? "Local evidence only" : entry.ownership === "unknown" ? "Not confirmed" : "Web API roster")}
          </div>

          <div class="detail-section">
            <h3>Developers</h3>
            <div class="chip-row">${entry.developers.map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join("") || `<p>Unknown</p>`}</div>
          </div>

          <div class="detail-section">
            <h3>Publishers</h3>
            <div class="chip-row">${entry.publishers.map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join("") || `<p>Unknown</p>`}</div>
          </div>

          <div class="detail-section">
            <h3>Genres and Storefront Categories</h3>
            <div class="chip-row">
              ${entry.genres.map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join("")}
              ${entry.categories.map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join("")}
              ${entry.genres.length + entry.categories.length === 0 ? "<p>No storefront metadata yet.</p>" : ""}
            </div>
          </div>

          <div class="detail-section">
            <h3>Tags <span style="color: var(--text-faint); font-weight: 400">· SteamSpy votes</span></h3>
            <div class="tag-row">
              ${
                tags.length
                  ? tags
                      .slice(0, 12)
                      .map(
                        ([name, votes]) =>
                          `<span class="tag-chip">${escapeHtml(name)} <span class="votes">${formatCount(votes)}</span></span>`,
                      )
                      .join("")
                  : `<p>No tags yet. Refresh metadata to fill this in.</p>`
              }
            </div>
          </div>

          <div class="detail-section">
            <h3>Steam Collections</h3>
            <div class="chip-row">${collections.map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join("") || `<p>None</p>`}</div>
          </div>

          <div class="detail-section">
            <h3>Metadata status</h3>
            <div class="source-list">
              <span class="${sourceTone(entry.metadata.tags)}">● Tags: ${escapeHtml(entry.metadata.tags)}</span>
              <span class="${sourceTone(entry.metadata.store)}">● Storefront: ${escapeHtml(entry.metadata.store)}</span>
              <span class="${sourceTone(entry.metadata.reviews)}">● Reviews: ${escapeHtml(entry.metadata.reviews)}</span>
            </div>
          </div>
        </div>

        <p class="launch-note">
          Launch opens the game through Steam. game-cat still never writes Steam files; the
          storefront link is safe.
        </p>
        <div class="detail-actions">
          <a class="primary" href="https://store.steampowered.com/app/${entry.appId}" target="_blank" rel="noopener noreferrer">${icon("external")} Store page</a>
          <button class="secondary" data-action="toggle-select" data-appid="${entry.appId}">${selected ? "Remove" : "Select"}</button>
          <button class="ghost" data-action="launch-game" data-appid="${entry.appId}" ${entry.installed === true ? "" : "disabled"} title="${entry.installed === true ? "Proposed launch action" : installLabel(entry.installed)}">${icon("play")} Launch</button>
        </div>
      </section>`;
  }

  function stat(label, value, hint, valueClass = "") {
    return `
      <div class="stat">
        <div class="stat-label">${escapeHtml(label)}</div>
        <div class="stat-value ${valueClass}">${escapeHtml(value)} <small>${escapeHtml(hint)}</small></div>
      </div>`;
  }
  /* ---------- Editor state updates ---------- */

  function updateRuleRow(index) {
    const row = $(`.rule-row[data-rule-index="${index}"]`);
    if (!row) return;
    const error = validateRule(state.editorRules[index]);
    row.classList.toggle("is-invalid", error !== null);
    const description = $(".rule-desc", row);
    if (description) description.textContent = describeRule(state.editorRules[index]);
    const errorNode = $(".rule-error", row);
    if (errorNode) {
      errorNode.hidden = error === null;
      errorNode.innerHTML = error === null ? "" : `${icon("warning")} ${escapeHtml(error)}`;
    }
  }

  function updatePrefixNote() {
    const counts = prefixCounts(state.editorRules);
    const node = $(".js-prefix-counts");
    if (node) node.textContent = `${counts.AND} AND · ${counts.OR} OR · ${counts.NOT} NOT`;
  }

  function refreshPreview() {
    if (state.view !== "smart") return;
    const matches = evaluateRules(state.editorRules, libraryGames()).length;
    $$(".js-match-count").forEach((node) => {
      node.textContent = formatCount(matches);
    });
    const summary = $(".match-summary");
    if (summary) summary.classList.toggle("is-empty", matches === 0);
    renderResults();
    renderTopbar();
  }

  function updateSaveState() {
    if (state.view !== "smart") return;
    const invalid = state.editorRules.filter((rule) => validateRule(rule) !== null).length;
    const nameMissing = state.editorName.trim() === "";
    const dirty = isSmartDirty();

    let text = "All changes saved";
    let tone = "is-saved";
    if (nameMissing) {
      text = "Name required";
      tone = "is-invalid";
    } else if (invalid > 0) {
      text = `Fix ${invalid} rule${invalid === 1 ? "" : "s"}`;
      tone = "is-invalid";
    } else if (dirty) {
      text = "Unsaved changes";
      tone = "";
    }

    $$(".dirty-state").forEach((node) => {
      node.className = `dirty-state ${tone}`;
      node.textContent = text;
    });
    $$(".js-save-state").forEach((node) => {
      node.textContent = `${text} · Rules save as a whole array.`;
    });
    $$("[data-action='save-collection']").forEach((button) => {
      button.disabled = nameMissing || invalid > 0 || !dirty;
    });
    updateCrumb();
  }

  function applyRuleValue(index, element) {
    const rule = state.editorRules[index];
    if (!rule) return;
    const definition = FIELDS[rule.field];
    let value;

    if (definition.kind === "hours") {
      const hours = Number.parseFloat(element.value);
      value = Number.isFinite(hours) ? Math.round(hours * 60) : null;
    } else if (definition.kind === "number" || definition.kind === "score") {
      value = element.value === "" ? null : Number(element.value);
    } else if (definition.kind === "date") {
      value = element.value || null;
    } else {
      value = element.value;
    }

    rule.value = value;
    state.dirty = true;
    updateRuleRow(index);
    refreshPreview();
    updateSaveState();
  }

  /* ---------- Collection actions ---------- */

  function guardDirty() {
    if (!isSmartDirty()) return true;
    return window.confirm("Discard unsaved changes to this Smart Collection?");
  }

  function openSmart(id) {
    if (!guardDirty()) return;
    loadSmart(id);
    state.view = "smart";
    state.search = "";
    state.draft = null;
    mirrorSearchInput();
    closeSidebar();
    state.focusMain = true;
    renderAll();
  }

  function openSteam(id) {
    if (!guardDirty()) return;
    state.view = "steam";
    state.activeSteamId = id;
    state.draft = null;
    state.search = "";
    state.gamePicker = null;
    mirrorSearchInput();
    closeSidebar();
    state.focusMain = true;
    renderAll();
  }

  function viewLibrary() {
    if (!guardDirty()) return;
    state.view = "library";
    state.draft = null;
    state.gamePicker = null;
    state.search = "";
    mirrorSearchInput();
    closeSidebar();
    state.focusMain = true;
    renderAll();
  }

  function viewInstalled() {
    if (!guardDirty()) return;
    state.view = "installed";
    state.draft = null;
    state.gamePicker = null;
    state.search = "";
    mirrorSearchInput();
    closeSidebar();
    state.focusMain = true;
    renderAll();
  }

  function newCollection(seedRules = [], seedName = "New Smart Collection") {
    if (!guardDirty()) return;
    state.view = "smart";
    state.activeSmartId = null;
    state.draft = { name: seedName };
    state.editorName = seedName;
    state.editorRules = deepCopy(seedRules);
    state.gamePicker = null;
    state.search = "";
    mirrorSearchInput();
    closeSidebar();
    state.focusAfterRender = { selector: ".collection-name", select: true };
    renderAll();
  }

  function addSelectionToRules(index = null) {
    const appIds = Array.from(state.selected);
    if (appIds.length === 0) return;
    let ruleIndex = index;

    if (ruleIndex == null) {
      ruleIndex = state.editorRules.findIndex((rule) => rule.field === "game");
      if (ruleIndex === -1) {
        state.editorRules.push({
          prefix: "AND",
          field: "game",
          operator: "in",
          value: appIds,
        });
        ruleIndex = state.editorRules.length - 1;
      }
    }

    const rule = state.editorRules[ruleIndex];
    if (!rule || rule.field !== "game") return;
    const merged = new Set(Array.isArray(rule.value) ? rule.value : []);
    for (const appId of appIds) merged.add(appId);
    rule.value = Array.from(merged);
    state.dirty = true;
    state.gamePicker = null;
    renderContent();
    renderTopbar();
    updateSaveState();
    state.focusAfterRender = {
      selector: `[data-action='toggle-game-picker'][data-index="${ruleIndex}"]`,
    };
    applyFocus();
    showToast(`${appIds.length} game${appIds.length === 1 ? "" : "s"} added to the game list`);
  }

  function saveCollection() {
    if (state.view !== "smart") return;
    const name = state.editorName.trim();
    if (!name) return;
    if (state.editorRules.some((rule) => validateRule(rule) !== null)) return;
    const conflict = SMART_COLLECTIONS.some(
      (collection) =>
        collection.id !== state.activeSmartId && normalize(collection.name) === normalize(name),
    );
    if (conflict) {
      showToast("Another Smart Collection already has that name.");
      return;
    }

    const now = new Date().toISOString();
    if (state.draft) {
      const id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `sc-${Date.now()}`;
      SMART_COLLECTIONS.push({
        id,
        name,
        rules: deepCopy(state.editorRules),
        createdAt: now,
        updatedAt: now,
      });
      state.activeSmartId = id;
      state.draft = null;
    } else {
      const collection = savedSmart();
      if (!collection) return;
      collection.name = name;
      collection.rules = deepCopy(state.editorRules);
      collection.updatedAt = now;
    }

    state.editorName = name;
    state.gamePicker = null;
    state.focusMain = true;
    renderAll();
    showToast("Smart Collection saved");
  }

  function revertCollection() {
    if (state.draft) {
      if (!window.confirm("Discard this draft Smart Collection?")) return;
      state.draft = null;
      state.view = "library";
      state.activeSmartId = null;
      state.gamePicker = null;
      state.focusMain = true;
      renderAll();
      return;
    }

    const collection = savedSmart();
    if (!collection) return;
    loadSmart(collection.id);
    state.search = "";
    mirrorSearchInput();
    state.focusMain = true;
    renderAll();
    showToast("Changes discarded");
  }

  function deleteCollection() {
    if (state.draft) {
      if (!window.confirm("Discard this draft Smart Collection?")) return;
      state.draft = null;
      state.view = "library";
      state.activeSmartId = null;
      state.gamePicker = null;
      state.focusMain = true;
      renderAll();
      showToast("Draft discarded");
      return;
    }

    const collection = savedSmart();
    if (!collection) return;
    if (!window.confirm(`Delete “${collection.name}”? This cannot be undone.`)) return;
    const index = SMART_COLLECTIONS.findIndex((entry) => entry.id === collection.id);
    if (index !== -1) SMART_COLLECTIONS.splice(index, 1);
    state.view = "library";
    state.activeSmartId = null;
    state.draft = null;
    state.gamePicker = null;
    state.focusMain = true;
    renderAll();
    showToast("Smart Collection deleted");
  }

  /* ---------- Editor actions ---------- */

  function valueFocusSelector(fieldKey, index) {
    const kind = FIELDS[fieldKey]?.kind;
    if (kind === "games") return "[data-picker-search]";
    if (kind === "boolean") return `[data-action='set-boolean'][data-index="${index}"]`;
    return `[data-rule-value="${index}"]`;
  }

  function addRule(fieldKey, prefix = "AND") {
    if (state.editorRules.length >= 100) {
      showToast("A Smart Collection can have at most 100 rules.");
      return;
    }
    const definition = FIELDS[fieldKey];
    if (!definition) return;
    const index = state.editorRules.length;
    const value = definition.default === undefined ? "" : deepCopy(definition.default);
    state.editorRules.push({
      prefix,
      field: fieldKey,
      operator: definition.defaultOperator,
      value,
    });
    state.dirty = true;

    if (definition.kind === "games") {
      state.gamePicker = { index, query: "" };
    } else {
      state.gamePicker = null;
    }

    renderContent();
    renderTopbar();
    updateSaveState();

    state.focusAfterRender =
      definition.kind === "games"
        ? { selector: "[data-picker-search]", atEnd: true }
        : { selector: `[data-rule-value="${index}"]` };
    applyFocus();
  }

  function removeRule(index) {
    if (index < 0 || index >= state.editorRules.length) return;
    state.editorRules.splice(index, 1);
    state.dirty = true;
    if (state.gamePicker) {
      if (state.gamePicker.index === index) state.gamePicker = null;
      else if (state.gamePicker.index > index) state.gamePicker.index -= 1;
    }
    renderContent();
    renderTopbar();
    updateSaveState();
    state.focusAfterRender = { selector: "[data-action='add-rule'][data-field='installed']" };
    applyFocus();
  }

  function setPrefix(index, prefix) {
    const rule = state.editorRules[index];
    if (!rule) return;
    rule.prefix = prefix;
    state.dirty = true;
    const row = $(`.rule-row[data-rule-index="${index}"]`);
    if (row) {
      row.classList.remove("prefix-AND", "prefix-OR", "prefix-NOT");
      row.classList.add(`prefix-${prefix}`);
      $$("[data-action='set-prefix']", row).forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.prefix === prefix));
      });
    }
    updatePrefixNote();
    refreshPreview();
    updateSaveState();
  }

  function setBoolean(index, value) {
    const rule = state.editorRules[index];
    if (!rule) return;
    rule.value = value;
    state.dirty = true;
    const row = $(`.rule-row[data-rule-index="${index}"]`);
    if (row) {
      $$("[data-action='set-boolean']", row).forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.value === String(value)));
      });
    }
    updateRuleRow(index);
    refreshPreview();
    updateSaveState();
  }

  function toggleGamePicker(index) {
    if (state.gamePicker && state.gamePicker.index === index) {
      state.gamePicker = null;
      renderContent();
      state.focusAfterRender = {
        selector: `[data-action='toggle-game-picker'][data-index="${index}"]`,
      };
      applyFocus();
    } else {
      state.gamePicker = { index, query: "" };
      renderContent();
      state.focusAfterRender = { selector: "[data-picker-search]", atEnd: true };
      applyFocus();
    }
  }

  function closeGamePicker(index) {
    state.gamePicker = null;
    renderContent();
    state.focusAfterRender = {
      selector: `[data-action='toggle-game-picker'][data-index="${index}"]`,
    };
    applyFocus();
  }

  function togglePickerGame(appId) {
    if (!state.gamePicker) return;
    const index = state.gamePicker.index;
    const rule = state.editorRules[index];
    if (!rule) return;
    const picked = new Set(Array.isArray(rule.value) ? rule.value : []);
    if (picked.has(appId)) picked.delete(appId);
    else picked.add(appId);
    rule.value = Array.from(picked);
    state.dirty = true;
    state.focusAfterRender = { selector: "[data-picker-search]", atEnd: true };
    renderContent();
    applyFocus();
    updateSaveState();
  }

  function useSelectionInPicker() {
    if (!state.gamePicker) return;
    addSelectionToRules(state.gamePicker.index);
  }

  function removeGame(index, appId) {
    const rule = state.editorRules[index];
    if (!rule || !Array.isArray(rule.value)) return;
    rule.value = rule.value.filter((value) => value !== appId);
    state.dirty = true;
    renderContent();
    renderTopbar();
    updateSaveState();
    state.focusAfterRender = {
      selector: `[data-action='toggle-game-picker'][data-index="${index}"]`,
    };
    applyFocus();
  }

  /* ---------- Selection ---------- */

  function toggleSelect(appId, focusSelector) {
    if (state.selected.has(appId)) state.selected.delete(appId);
    else state.selected.add(appId);
    updateSelectionUI(focusSelector);
  }

  function updateSelectionUI(focusSelector) {
    renderSelectionBar();
    renderResults();
    const count = state.selected.size;
    $$("[data-action='use-selection']").forEach((button) => {
      button.disabled = count === 0;
      button.textContent = `Use selection (${count})`;
    });
    $$("[data-action='picker-use-selection']").forEach((button) => {
      button.disabled = count === 0;
      button.textContent = `Use selection (${count})`;
    });
    if (state.drawerAppId) renderDetail();
    if (focusSelector) {
      const element = $(focusSelector);
      if (element) element.focus({ preventScroll: true });
    }
  }

  function selectVisible() {
    for (const appId of state.lastVisibleIds) state.selected.add(appId);
    updateSelectionUI("[data-action='select-visible']");
  }

  function clearSelection() {
    state.selected.clear();
    updateSelectionUI("[data-action='clear-selection']");
  }

  /* ---------- Scenario, refresh, timer ---------- */

  function updateUrl() {
    try {
      const url = new URL(window.location.href);
      if (state.scenario === "normal") url.searchParams.delete("scenario");
      else url.searchParams.set("scenario", state.scenario);
      window.history.replaceState(null, "", url);
    } catch {
      /* file:// and sandboxed contexts can refuse history updates */
    }
  }

  function setScenario(scenario) {
    if (["first-run", "loading", "empty"].includes(scenario) && !guardDirty()) {
      renderScenarioSelect();
      return;
    }
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (scanTimer) {
      window.clearTimeout(scanTimer);
      scanTimer = null;
    }

    state.scenario = scenario;

    if (["first-run", "loading", "empty"].includes(scenario)) {
      state.view = "library";
      state.draft = null;
      state.gamePicker = null;
      state.search = "";
      state.selected.clear();
      mirrorSearchInput();
    }

    if (scenario === "refreshing") {
      state.refresh = { done: 0, total: GAMES.length };
    }

    updateUrl();
    renderAll();

    if (scenario === "refreshing") startRefreshSim();
  }

  function startRefreshSim() {
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(() => {
      state.refresh.done = Math.min(state.refresh.total, state.refresh.done + 1);
      const count = $("[data-refresh-count]");
      const bar = $("[data-refresh-bar]");
      if (count) count.textContent = `${state.refresh.done} of ${state.refresh.total}`;
      if (bar) bar.style.width = `${Math.round((state.refresh.done / state.refresh.total) * 100)}%`;

      if (state.refresh.done >= state.refresh.total) {
        window.clearInterval(refreshTimer);
        refreshTimer = null;
        state.scenario = "normal";
        updateUrl();
        renderAll();
        showToast(`Metadata refresh complete · ${state.refresh.total} games`);
      }
    }, 520);
  }

  function scanLibrary() {
    if (state.scenario === "first-run") {
      const key = $("#api-key");
      if (!key || key.value.trim() === "") {
        showToast("A Steam Web API key is required for the full roster.");
        key?.focus();
        return;
      }
    }
    setScenario("loading");
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      state.scenario = "normal";
      updateUrl();
      renderAll();
      showToast(`Scan complete · ${GAMES.length} games found`);
    }, 1600);
  }

  function retryOwnership() {
    if (scanTimer) window.clearTimeout(scanTimer);
    showToast("Retrying ownership refresh…");
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      state.scenario = "normal";
      updateUrl();
      renderAll();
      showToast(`Ownership refreshed · ${GAMES.length} games owned`);
    }, 1400);
  }

  function formatTimer(ms) {
    const total = Math.floor(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  function updateTimerDisplay() {
    const display = $("#timer-display");
    if (!display) return;
    const elapsed = state.timer.running ? Date.now() - state.timer.startedAt : state.timer.elapsed;
    display.textContent = formatTimer(elapsed);
    display.classList.toggle("is-over", elapsed >= 60_000);
  }

  function renderTimerButton() {
    const button = $("[data-action='toggle-timer']");
    if (button) button.textContent = state.timer.running ? "Stop task" : "Start 60s task";
  }

  function toggleTimer() {
    if (state.timer.running) {
      state.timer.elapsed = Date.now() - state.timer.startedAt;
      state.timer.running = false;
      if (timerInterval) window.clearInterval(timerInterval);
      timerInterval = null;
    } else {
      state.timer.startedAt = Date.now() - state.timer.elapsed;
      state.timer.running = true;
      timerInterval = window.setInterval(updateTimerDisplay, 200);
    }
    renderTimerButton();
    updateTimerDisplay();
  }

  function resetTimer() {
    if (timerInterval) window.clearInterval(timerInterval);
    timerInterval = null;
    state.timer = { running: false, startedAt: 0, elapsed: 0 };
    renderTimerButton();
    updateTimerDisplay();
  }

  /* ---------- Dialogs and toasts ---------- */

  function showDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function hideDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function openDetail(appId) {
    state.drawerAppId = Number(appId);
    renderDetail();
    const dialog = $("#detail-dialog");
    showDialog(dialog);
    const close = $("[data-action='close-detail']");
    if (close) close.focus();
  }

  function closeDetail() {
    state.drawerAppId = null;
    hideDialog($("#detail-dialog"));
  }

  function showToast(message) {
    const root = $("#toast-root");
    if (!root) return;
    while (root.children.length >= 3) root.firstElementChild.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `${icon("check")}<span>${escapeHtml(message)}</span>`;
    root.append(toast);
    window.setTimeout(() => toast.remove(), 3200);
  }

  function openNotes() {
    const dialog = $("#notes-dialog");
    showDialog(dialog);
    const close = $("[data-action='close-notes']");
    if (close) close.focus();
  }

  function closeNotes() {
    hideDialog($("#notes-dialog"));
  }

  function closeSidebar() {
    const sidebar = $("#sidebar");
    if (!sidebar) return;
    sidebar.classList.remove("is-open");
    $("#sidebar-scrim")?.classList.remove("is-open");
    const button = $("[data-action='toggle-sidebar']");
    if (button) button.setAttribute("aria-expanded", "false");
  }

  /* ---------- Event handling ---------- */

  function handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    if (button.tagName !== "A") event.preventDefault();

    const action = button.dataset.action;
    const index = button.dataset.index == null ? null : Number(button.dataset.index);
    const appId = button.dataset.appid == null ? null : Number(button.dataset.appid);

    switch (action) {
      case "toggle-sidebar": {
        const sidebar = $("#sidebar");
        if (!sidebar) break;
        const open = sidebar.classList.toggle("is-open");
        $("#sidebar-scrim")?.classList.toggle("is-open", open);
        button.setAttribute("aria-expanded", String(open));
        break;
      }
      case "close-sidebar":
        closeSidebar();
        break;
      case "toggle-proto":
        state.protoOpen = !state.protoOpen;
        renderProtoBar();
        break;
      case "view-library":
        viewLibrary();
        break;
      case "view-installed":
        viewInstalled();
        break;
      case "open-smart":
        openSmart(button.dataset.id);
        break;
      case "open-draft":
        state.focusAfterRender = { selector: ".collection-name", select: true };
        applyFocus();
        break;
      case "open-steam":
        openSteam(button.dataset.id);
        break;
      case "new-collection":
        newCollection();
        break;
      case "new-from-selection": {
        const appIds = Array.from(state.selected);
        if (appIds.length === 0) {
          showToast("Select a few games first.");
          break;
        }
        newCollection(
          [{ prefix: "AND", field: "game", operator: "in", value: appIds }],
          "Selected games",
        );
        break;
      }
      case "new-from-steam": {
        const collection = currentSteam();
        if (!collection || collection.isDynamic) break;
        newCollection(
          [
            {
              prefix: "AND",
              field: "steamCollection",
              operator: "has",
              value: collection.id,
            },
          ],
          `From ${collection.name}`,
        );
        break;
      }
      case "add-selection-to-rules":
        addSelectionToRules();
        break;
      case "clear-selection":
        clearSelection();
        break;
      case "select-visible":
        selectVisible();
        break;
      case "sort-column": {
        const field = button.dataset.sort;
        if (state.sort === field) {
          state.order = state.order === "asc" ? "desc" : "asc";
        } else {
          state.sort = field;
          state.order = "asc";
        }
        renderTopbar();
        renderResults();
        break;
      }
      case "toggle-order":
        state.order = state.order === "asc" ? "desc" : "asc";
        renderTopbar();
        renderResults();
        break;
      case "toggle-installed":
        state.installedOnly = !state.installedOnly;
        renderTopbar();
        renderContent();
        break;
      case "set-layout":
        state.layout = button.dataset.layout;
        renderTopbar();
        renderResults();
        break;
      case "clear-search":
        state.search = "";
        mirrorSearchInput();
        renderContent();
        $("#search")?.focus();
        break;
      case "reset-filters":
        state.installedOnly = false;
        state.search = "";
        mirrorSearchInput();
        renderTopbar();
        renderContent();
        break;
      case "add-rule":
        addRule(button.dataset.field, button.dataset.prefix ?? "AND");
        break;
      case "remove-rule":
        removeRule(index);
        break;
      case "remove-last-rule":
        removeRule(state.editorRules.length - 1);
        break;
      case "set-prefix":
        setPrefix(index, button.dataset.prefix);
        break;
      case "set-boolean":
        setBoolean(index, button.dataset.value === "true");
        break;
      case "toggle-game-picker":
        toggleGamePicker(index);
        break;
      case "picker-done":
        closeGamePicker(state.gamePicker?.index ?? index);
        break;
      case "picker-use-selection":
        useSelectionInPicker();
        break;
      case "use-selection":
        addSelectionToRules(index);
        break;
      case "remove-game":
        removeGame(index, appId);
        break;
      case "save-collection":
        saveCollection();
        break;
      case "revert-collection":
        revertCollection();
        break;
      case "delete-collection":
        deleteCollection();
        break;
      case "open-game":
        openDetail(appId);
        break;
      case "close-detail":
        closeDetail();
        break;
      case "toggle-select":
        toggleSelect(appId, `[data-action='toggle-select'][data-appid="${appId}"]`);
        break;
      case "launch-game":
        showToast(
          `Prototype only: would launch ${gameById(appId)?.name ?? "the game"} through Steam.`,
        );
        break;
      case "refresh":
        setScenario("refreshing");
        showToast("Refreshing metadata for the whole library.");
        break;
      case "refresh-details":
        showToast("SteamSpy and the storefront are rate limited to about one request per second.");
        break;
      case "retry-ownership":
        retryOwnership();
        break;
      case "fix-key":
        showToast("Prototype only: would open Settings → Steam Web API key.");
        break;
      case "scan-library":
        scanLibrary();
        break;
      case "browse-folder":
        showToast("Prototype only: would open a folder picker.");
        break;
      case "open-notes":
        openNotes();
        break;
      case "close-notes":
        closeNotes();
        break;
      case "toggle-timer":
        toggleTimer();
        break;
      case "reset-timer":
        resetTimer();
        break;
      default:
        break;
    }
  }

  function handleChange(event) {
    const target = event.target;

    if (target.id === "sort") {
      state.sort = target.value;
      renderResults();
      return;
    }

    if (target.id === "scenario") {
      setScenario(target.value);
      return;
    }

    if (target.matches("[data-select-game]")) {
      const appId = Number(target.dataset.selectGame);
      toggleSelect(appId, `[data-select-game="${appId}"]`);
      return;
    }

    if (target.matches("[data-select-all]")) {
      if (target.checked) {
        for (const appId of state.lastVisibleIds) state.selected.add(appId);
      } else {
        for (const appId of state.lastVisibleIds) state.selected.delete(appId);
      }
      updateSelectionUI("[data-action='select-visible']");
      return;
    }

    if (target.matches("[data-rule-field]")) {
      const index = Number(target.dataset.ruleField);
      const rule = state.editorRules[index];
      const definition = FIELDS[target.value];
      if (!rule || !definition) return;
      rule.field = target.value;
      rule.operator = definition.defaultOperator;
      rule.value = definition.default === undefined ? "" : deepCopy(definition.default);
      state.dirty = true;
      state.gamePicker = definition.kind === "games" ? { index, query: "" } : null;
      renderContent();
      renderTopbar();
      updateSaveState();
      state.focusAfterRender =
        definition.kind === "games"
          ? { selector: "[data-picker-search]", atEnd: true }
          : { selector: `[data-rule-value="${index}"]` };
      applyFocus();
      return;
    }

    if (target.matches("[data-rule-operator]")) {
      const index = Number(target.dataset.ruleOperator);
      const rule = state.editorRules[index];
      if (!rule) return;
      rule.operator = target.value;
      state.dirty = true;
      updateRuleRow(index);
      refreshPreview();
      updateSaveState();
      return;
    }

    if (target.matches("[data-rule-value]")) {
      const index = Number(target.dataset.ruleValue);
      applyRuleValue(index, target);
      return;
    }

    if (target.matches("[data-picker-game]")) {
      togglePickerGame(Number(target.dataset.pickerGame));
      return;
    }

    if (target.matches("[data-collection-name]")) {
      state.editorName = target.value;
      updateSaveState();
    }
  }

  function handleInput(event) {
    const target = event.target;

    if (target.id === "search") {
      state.search = target.value;
      const clear = $("#search-clear");
      if (clear) clear.hidden = state.search.length === 0;
      renderResults();
      return;
    }

    if (target.matches("[data-collection-name]")) {
      state.editorName = target.value;
      updateSaveState();
      updateCrumb();
      renderSidebar();
      return;
    }

    if (target.matches("[data-rule-value]")) {
      const index = Number(target.dataset.ruleValue);
      applyRuleValue(index, target);
      return;
    }

    if (target.matches("[data-picker-search]")) {
      if (!state.gamePicker) return;
      state.gamePicker.query = target.value;
      state.focusAfterRender = { selector: "[data-picker-search]", atEnd: true };
      renderContent();
      applyFocus();
    }
  }

  function handleKeydown(event) {
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.matches("input, textarea, select") || target.isContentEditable);

    if (
      (event.key === "Enter" || event.key === " ") &&
      target instanceof HTMLElement &&
      target.matches('[role="button"][data-action]')
    ) {
      event.preventDefault();
      target.click();
      return;
    }

    if (event.key === "/" && !typing) {
      event.preventDefault();
      $("#search")?.focus();
      return;
    }

    if (event.key === "Escape") {
      if (state.gamePicker) {
        const index = state.gamePicker.index;
        closeGamePicker(index);
        return;
      }
      if ($("#sidebar")?.classList.contains("is-open")) {
        closeSidebar();
        return;
      }
      if (target.id === "search" && state.search) {
        state.search = "";
        mirrorSearchInput();
        renderContent();
        return;
      }
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      if (state.view === "smart") {
        event.preventDefault();
        saveCollection();
      }
      return;
    }

    if (event.key === "Enter" && target.matches("[data-collection-name]")) {
      target.blur();
    }
  }

  /* ---------- Init ---------- */

  function init() {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("scenario");
    const allowed = ["normal", "first-run", "loading", "empty", "refreshing", "error"];
    state.scenario = allowed.includes(requested) ? requested : "normal";

    loadSmart("short-coop-nights");
    if (["first-run", "loading", "empty"].includes(state.scenario)) {
      state.view = "library";
      state.draft = null;
    }

    document.addEventListener("click", handleClick);
    document.addEventListener("change", handleChange);
    document.addEventListener("input", handleInput);
    document.addEventListener("keydown", handleKeydown);

    let wasNarrow = window.innerWidth <= 980;
    window.addEventListener("resize", () => {
      const narrow = window.innerWidth <= 980;
      if (narrow !== wasNarrow) {
        wasNarrow = narrow;
        state.protoOpen = !narrow;
        renderProtoBar();
      }
    });

    const detailDialog = $("#detail-dialog");
    if (detailDialog) {
      detailDialog.addEventListener("close", () => {
        state.drawerAppId = null;
      });
      detailDialog.addEventListener("click", (event) => {
        if (event.target === detailDialog) closeDetail();
      });
    }

    const notesDialog = $("#notes-dialog");
    if (notesDialog) {
      notesDialog.addEventListener("click", (event) => {
        if (event.target === notesDialog) closeNotes();
      });
    }

    renderAll();
    updateTimerDisplay();

    if (state.scenario === "refreshing") startRefreshSim();
  }

  init();
})();
