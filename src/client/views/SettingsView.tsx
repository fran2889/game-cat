import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { SteamAccount } from "../../shared/types.ts";
import { ApiError, fetchSteamAccounts, patchConfig, type ConfigPatch } from "../api.ts";
import { useToast } from "../components/ToastProvider.tsx";
import { LOG_LEVELS } from "../../shared/types.ts";
import type { ShellContext } from "../shell-context.ts";

const API_KEY_URL = "https://steamcommunity.com/dev/apikey";

const KEY_SOURCE_LABEL: Record<string, string> = {
  file: "Saved in config.json",
  env: "Managed by GAME_CAT_STEAM_API_KEY",
  none: "No key configured",
};

function isAbsoluteSteamPath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
}

export function SettingsView() {
  const { status, config, reloadStatus, reloadConfig, applyConfig } =
    useOutletContext<ShellContext>();
  const { showToast } = useToast();

  const [steamRoot, setSteamRoot] = useState("");
  const [steamId64, setSteamId64] = useState("");
  const [accounts, setAccounts] = useState<SteamAccount[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [port, setPort] = useState("");
  const [openBrowser, setOpenBrowser] = useState(true);
  const [logLevel, setLogLevel] = useState("info");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config === null) {
      return;
    }
    setSteamRoot(config.steamRoot ?? "");
    setSteamId64(config.steamId64 ?? "");
    setPort(String(config.port));
    setOpenBrowser(config.openBrowser);
    setLogLevel(config.logLevel);
  }, [config]);

  const loadAccounts = useCallback(() => {
    const controller = new AbortController();
    void fetchSteamAccounts(controller.signal)
      .then((next) => setAccounts(next))
      .catch(() => setAccounts([]));
    return () => controller.abort();
  }, []);

  useEffect(() => loadAccounts(), [loadAccounts]);

  if (config === null) {
    return (
      <section className="settings" aria-busy="true">
        <p>Loading settings…</p>
      </section>
    );
  }

  const envManaged = config.steamApiKeySource === "env";
  const accountOptions = [...accounts];
  if (steamId64 !== "" && !accountOptions.some((account) => account.steamId64 === steamId64)) {
    const selected = status?.steam.account;
    accountOptions.unshift(
      selected !== null && selected !== undefined
        ? selected
        : { steamId64, accountId: "", personaName: steamId64 },
    );
  }

  const save = async (): Promise<void> => {
    setFormError(null);
    setFieldErrors({});

    const parsedPort = Number.parseInt(port, 10);
    if (!/^\d+$/.test(port.trim()) || !Number.isInteger(parsedPort) || parsedPort > 65535) {
      setFieldErrors({ port: "Enter an integer between 0 and 65535." });
      return;
    }
    if (steamRoot.trim() !== "" && !isAbsoluteSteamPath(steamRoot)) {
      setFieldErrors({ steamRoot: "Enter an absolute path to the Steam folder." });
      return;
    }

    const patch: ConfigPatch = {};
    if (steamRoot.trim() !== (config.steamRoot ?? "")) {
      patch.steamRoot = steamRoot.trim();
    }
    if (steamId64 !== (config.steamId64 ?? "")) {
      patch.steamId64 = steamId64;
    }
    if (!envManaged && apiKey.trim() !== "") {
      patch.steamApiKey = apiKey.trim();
    }
    if (parsedPort !== config.port) {
      patch.port = parsedPort;
    }
    if (openBrowser !== config.openBrowser) {
      patch.openBrowser = openBrowser;
    }
    if (logLevel !== config.logLevel) {
      patch.logLevel = logLevel;
    }

    if (Object.keys(patch).length === 0) {
      setRestartRequired(false);
      showToast("Settings are already up to date.");
      return;
    }

    setSaving(true);
    try {
      const result = await patchConfig(patch);
      setApiKey("");
      setRestartRequired(result.meta.restartRequired);
      applyConfig(result.data);
      reloadConfig();
      reloadStatus();
      showToast(
        result.meta.restartRequired
          ? "Settings saved. Restart game-cat to use the new port."
          : "Settings saved.",
      );
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
        setFormError(error.message);
      } else {
        setFormError("The settings could not be saved.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings" aria-labelledby="settings-heading">
      <header className="settings-head">
        <p className="placeholder-kicker">Settings</p>
        <h2 id="settings-heading">Configuration</h2>
        <p>
          game-cat reads these settings from the data directory. Secrets are write-only and are
          never shown here.
        </p>
      </header>

      <dl className="settings-facts">
        <div>
          <dt>Data directory</dt>
          <dd>
            <code>{config.dataDir}</code>
          </dd>
        </div>
        <div>
          <dt>Listening URL</dt>
          <dd>
            <code>{config.listeningUrl}</code>
          </dd>
        </div>
        <div>
          <dt>Steam Web API key</dt>
          <dd>
            {config.steamApiKeySet ? "Configured" : "Not configured"} ·{" "}
            {KEY_SOURCE_LABEL[config.steamApiKeySource] ?? config.steamApiKeySource}
          </dd>
        </div>
        <div>
          <dt>Selected Account</dt>
          <dd>
            {status?.steam.account === null || status?.steam.account === undefined
              ? "No Steam Account selected"
              : `${status.steam.account.personaName} · ${status.steam.account.steamId64}`}
          </dd>
        </div>
      </dl>

      {formError !== null && (
        <div className="banner banner-error" role="alert">
          <div>
            <strong>The settings are not saved.</strong>
            <p>{formError}</p>
          </div>
        </div>
      )}

      {restartRequired === true && (
        <div className="banner banner-warning" role="status">
          <div>
            <strong>Restart required.</strong>
            <p>
              The listening socket does not move until the next start. The current address is{" "}
              <code>{config.listeningUrl}</code>; after restart game-cat will listen on the new
              port.
            </p>
          </div>
        </div>
      )}

      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset>
          <legend>Steam</legend>

          <div className="field">
            <label htmlFor="settings-steam-root">Steam root</label>
            <input
              id="settings-steam-root"
              type="text"
              value={steamRoot}
              autoComplete="off"
              aria-invalid={fieldErrors.steamRoot !== undefined}
              onChange={(event) => setSteamRoot(event.target.value)}
            />
            {fieldErrors.steamRoot !== undefined && (
              <p className="field-error">{fieldErrors.steamRoot}</p>
            )}
            <p className="field-hint">
              A configured path is authoritative. A missing folder is reported, not replaced by
              auto-discovery.
            </p>
          </div>

          <div className="field">
            <label htmlFor="settings-account">Steam Account</label>
            <select
              id="settings-account"
              value={steamId64}
              onChange={(event) => setSteamId64(event.target.value)}
            >
              {accountOptions.length === 0 && <option value="">No Account detected</option>}
              {accountOptions.map((account) => (
                <option key={account.steamId64} value={account.steamId64}>
                  {account.personaName} · {account.steamId64}
                </option>
              ))}
            </select>
            {fieldErrors.steamId64 !== undefined && (
              <p className="field-error">{fieldErrors.steamId64}</p>
            )}
            <p className="field-hint">
              Switching Accounts requires a new data directory. AccountName is never shown.
            </p>
          </div>

          <div className="field">
            <label htmlFor="settings-api-key">Steam Web API key</label>
            <input
              id="settings-api-key"
              type="password"
              value={apiKey}
              placeholder={config.steamApiKeySet ? "•••••••• (saved)" : "Paste your key"}
              autoComplete="off"
              disabled={envManaged}
              aria-describedby="settings-api-key-hint"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <p className="field-hint" id="settings-api-key-hint">
              {envManaged
                ? "Managed by GAME_CAT_STEAM_API_KEY. Change the environment variable and restart to replace the key."
                : "Write-only. Leave blank to keep the saved key."}{" "}
              <a href={API_KEY_URL} target="_blank" rel="noopener noreferrer">
                Get a Steam Web API key
              </a>
            </p>
            {fieldErrors.steamApiKey !== undefined && (
              <p className="field-error">{fieldErrors.steamApiKey}</p>
            )}
          </div>
        </fieldset>

        <fieldset>
          <legend>Server</legend>

          <div className="settings-row">
            <div className="field">
              <label htmlFor="settings-port">Port</label>
              <input
                id="settings-port"
                type="number"
                min={0}
                max={65535}
                value={port}
                aria-invalid={fieldErrors.port !== undefined}
                onChange={(event) => setPort(event.target.value)}
              />
              {fieldErrors.port !== undefined && <p className="field-error">{fieldErrors.port}</p>}
              <p className="field-hint">
                0 asks the OS for a free port. A port change takes effect on the next start.
              </p>
            </div>

            <div className="field">
              <label htmlFor="settings-log-level">Log level</label>
              <select
                id="settings-log-level"
                value={logLevel}
                onChange={(event) => setLogLevel(event.target.value)}
              >
                {LOG_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
              <p className="field-hint">Applies immediately.</p>
            </div>
          </div>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={openBrowser}
              onChange={(event) => setOpenBrowser(event.target.checked)}
            />
            <span>Open the browser on the next start</span>
          </label>
        </fieldset>

        <div className="settings-actions">
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
          {restartRequired === false && (
            <span className="field-hint" role="status">
              Settings saved. No restart required.
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
