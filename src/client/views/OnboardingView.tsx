import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  ApiError,
  patchConfig,
  startAllFetch,
  steamAccountsQueryOptions,
  type ConfigPatch,
} from "../api.ts";
import type { ShellContext } from "../shell-context.ts";

const API_KEY_URL = "https://steamcommunity.com/dev/apikey";

function isAbsoluteSteamPath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
}

export function OnboardingView() {
  const { status, config, reloadStatus, applyConfig } = useOutletContext<ShellContext>();
  const navigate = useNavigate();

  const [steamRoot, setSteamRoot] = useState("");
  const [editingRoot, setEditingRoot] = useState(false);
  const [selectedSteamId64, setSelectedSteamId64] = useState("");
  const accountsQuery = useQuery(steamAccountsQueryOptions);
  const accounts = accountsQuery.data ?? [];
  const accountsError =
    accountsQuery.error === null ? null : (accountsQuery.error as Error).message;
  const saveConfigMutation = useMutation({ mutationFn: patchConfig });
  const startFetchMutation = useMutation({ mutationFn: startAllFetch });
  const [apiKey, setApiKey] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (config === null && status === null) {
      return;
    }
    setSteamRoot((current) =>
      current === "" ? (config?.steamRoot ?? status?.steam.root ?? "") : current,
    );
    setSelectedSteamId64((current) =>
      current === "" ? (config?.steamId64 ?? status?.steam.account?.steamId64 ?? "") : current,
    );
  }, [config, status]);

  const envManaged = config?.steamApiKeySource === "env";
  const keyConfigured = config?.steamApiKeySet === true;
  const selectedAccount =
    accounts.find((account) => account.steamId64 === selectedSteamId64) ??
    status?.steam.account ??
    null;
  const steamMissing = status?.steam.state === "not_found";
  const noAccount = status?.steam.state === "no_account";
  const ambiguousAccount = status?.steam.ambiguous === true;
  const invalidKey = status?.ownership.state === "invalid_key";
  const emptyRoster = status?.ownership.state === "empty" && status.library.gameCount > 0;

  const confirmRoot = (): boolean => {
    if (steamRoot.trim() === "" || !isAbsoluteSteamPath(steamRoot)) {
      setFieldErrors((current) => ({
        ...current,
        steamRoot: "Enter an absolute path to the Steam folder.",
      }));
      return false;
    }
    setFieldErrors((current) => ({ ...current, steamRoot: "" }));
    setEditingRoot(false);
    return true;
  };

  const startScan = async (): Promise<void> => {
    setFormError(null);
    setFieldErrors({});

    if (!keyConfigured && !envManaged && apiKey.trim() === "") {
      setFieldErrors({ steamApiKey: "A Steam Web API key is required." });
      return;
    }
    if (steamRoot.trim() !== "" && !isAbsoluteSteamPath(steamRoot)) {
      setFieldErrors({ steamRoot: "Enter an absolute path to the Steam folder." });
      setEditingRoot(true);
      return;
    }

    const patch: ConfigPatch = {};
    if (steamRoot.trim() !== "" && steamRoot.trim() !== config?.steamRoot) {
      patch.steamRoot = steamRoot.trim();
    }
    if (selectedSteamId64 !== "") {
      // Confirming the Account pins it in config.json, even when discovery
      // supplied the same value.
      patch.steamId64 = selectedSteamId64;
    }
    if (!envManaged && apiKey.trim() !== "") {
      patch.steamApiKey = apiKey.trim();
    }

    setScanning(true);
    try {
      if (Object.keys(patch).length > 0) {
        const saved = await saveConfigMutation.mutateAsync(patch);
        applyConfig(saved.data);
      }
      await startFetchMutation.mutateAsync();
      setApiKey("");
      reloadStatus();
      navigate("/");
    } catch (error) {
      if (error instanceof ApiError) {
        const errors = error.fieldErrors;
        if (Object.keys(errors).length > 0) {
          setFieldErrors(errors);
        }
        setFormError(error.message);
        if (error.code === "ACCOUNT_BOUND") {
          setFormError(
            "This data directory is already bound to a different Steam Account. Switching Accounts requires a new data directory.",
          );
        }
      } else {
        setFormError("The setup could not be completed. Check the server and try again.");
      }
    } finally {
      setScanning(false);
    }
  };

  const retry = async (): Promise<void> => {
    setFormError(null);
    try {
      await startFetchMutation.mutateAsync();
      reloadStatus();
      navigate("/");
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : "The Retry could not start a Fetch.",
      );
    }
  };

  return (
    <section className="onboarding" aria-labelledby="onboarding-heading">
      <header className="onboarding-head">
        <span className="onboarding-mark" aria-hidden="true">
          GC
        </span>
        <div>
          <p className="placeholder-kicker">Setup</p>
          <h2 id="onboarding-heading">Connect your Steam library</h2>
          <p>
            Steam folder, Account, and a Steam Web API key are all this setup needs. The first Fetch
            starts only after you choose Scan.
          </p>
        </div>
      </header>

      {ambiguousAccount && (
        <div className="banner banner-warning" role="status" data-testid="ambiguous-account">
          <div>
            <strong>Several Steam Accounts were found.</strong>
            <p>
              game-cat selected the most recently used Account. Confirm the right one below before
              scanning; the picker stays available here and in Settings.
            </p>
          </div>
          <a className="button" href="#steam-account">
            Choose Account
          </a>
        </div>
      )}

      {invalidKey && (
        <div className="banner banner-error" role="alert">
          <div>
            <strong>Steam rejected the Web API key.</strong>
            <p>
              Enter a new key below and Scan again. Your cached Library was kept and nothing was
              deleted.
            </p>
          </div>
          <button type="button" className="button" onClick={() => void retry()}>
            Retry
          </button>
        </div>
      )}

      {emptyRoster && (
        <div className="banner banner-warning" role="status">
          <div>
            <strong>Steam returned no owned Games.</strong>
            <p>
              If this Account owns Games, its Steam profile may be private. Local evidence is kept;
              game-cat cannot claim the Library is complete.
            </p>
          </div>
          <div className="banner-actions">
            <button type="button" className="button" onClick={() => void retry()}>
              Retry
            </button>
            <a className="button" href="#api-key">
              Fix API key
            </a>
          </div>
        </div>
      )}

      {formError !== null && (
        <div className="banner banner-error" role="alert">
          <div>
            <strong>The setup is not saved yet.</strong>
            <p>{formError}</p>
          </div>
        </div>
      )}

      <ol className="onboarding-steps">
        <li className="setup-step">
          <span className="step-number" aria-hidden="true">
            1
          </span>
          <div className="setup-step-body">
            <h3>Steam folder</h3>
            {steamMissing ? (
              <p>
                Steam was not found at the configured path. Install or start Steam, then recheck.
                You can also enter the folder manually.
              </p>
            ) : (
              <p>game-cat found your local Steam installation. Change the path if needed.</p>
            )}

            {editingRoot ? (
              <div className="field">
                <label htmlFor="steam-root">Steam root</label>
                <div className="field-row">
                  <input
                    id="steam-root"
                    type="text"
                    value={steamRoot}
                    autoComplete="off"
                    aria-invalid={fieldErrors.steamRoot !== undefined}
                    aria-describedby={
                      fieldErrors.steamRoot === undefined ? undefined : "steam-root-error"
                    }
                    onChange={(event) => setSteamRoot(event.target.value)}
                  />
                  <button type="button" className="button" onClick={() => confirmRoot()}>
                    Use this folder
                  </button>
                </div>
                {fieldErrors.steamRoot !== undefined && fieldErrors.steamRoot !== "" && (
                  <p className="field-error" id="steam-root-error">
                    {fieldErrors.steamRoot}
                  </p>
                )}
              </div>
            ) : (
              <div className="setup-value">
                <code>{steamRoot === "" ? "No Steam folder detected" : steamRoot}</code>
                <span className={steamMissing ? "input-warn" : "input-ok"}>
                  {steamMissing ? "Not found" : steamRoot === "" ? "Not detected" : "Detected"}
                </span>
                <button type="button" className="button" onClick={() => setEditingRoot(true)}>
                  Change
                </button>
              </div>
            )}
          </div>
        </li>

        <li className="setup-step" id="steam-account">
          <span className="step-number" aria-hidden="true">
            2
          </span>
          <div className="setup-step-body">
            <h3>Steam Account</h3>
            {noAccount || accounts.length === 0 ? (
              <p>
                No Steam Account was detected. Start Steam and sign in once, then recheck. An
                Account choice is required before Steam can return an owned-games roster.
              </p>
            ) : (
              <p>The selected Account is shown as PersonaName and SteamID64.</p>
            )}

            {accounts.length > 1 ? (
              <fieldset className="account-picker">
                <legend>Choose a Steam Account</legend>
                {accounts.map((account) => (
                  <label key={account.steamId64} className="account-option">
                    <input
                      type="radio"
                      name="steam-account"
                      value={account.steamId64}
                      checked={selectedSteamId64 === account.steamId64}
                      onChange={() => setSelectedSteamId64(account.steamId64)}
                    />
                    <span>
                      <strong>{account.personaName}</strong>{" "}
                      <span className="account-meta">{account.steamId64}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : selectedAccount !== null ? (
              <div className="setup-value">
                <strong>{selectedAccount.personaName}</strong>
                <span className="account-meta">{selectedAccount.steamId64}</span>
              </div>
            ) : null}

            <div className="setup-actions">
              <button type="button" className="button" onClick={() => void accountsQuery.refetch()}>
                Recheck accounts
              </button>
              {accountsError !== null && <span className="field-error">{accountsError}</span>}
            </div>
          </div>
        </li>

        <li className="setup-step">
          <span className="step-number" aria-hidden="true">
            3
          </span>
          <div className="setup-step-body">
            <h3>Steam Web API key</h3>
            <p>
              Required for the owned-games roster. game-cat never verifies the key until the first
              Fetch, and never sends the key to the browser after it is saved.
            </p>
            <div className="field">
              <label htmlFor="api-key">Steam Web API key</label>
              <div className="field-row">
                <input
                  id="api-key"
                  type="password"
                  value={apiKey}
                  placeholder={keyConfigured ? "•••••••• (saved)" : "Paste your key"}
                  autoComplete="off"
                  disabled={envManaged}
                  required={!keyConfigured && !envManaged}
                  aria-required={!keyConfigured && !envManaged}
                  aria-invalid={fieldErrors.steamApiKey !== undefined}
                  aria-describedby={
                    fieldErrors.steamApiKey === undefined ? undefined : "api-key-error"
                  }
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <a className="button" href={API_KEY_URL} target="_blank" rel="noopener noreferrer">
                  Get a Steam Web API key
                </a>
              </div>
              {envManaged ? (
                <p className="field-hint" id="api-key-managed">
                  Managed by GAME_CAT_STEAM_API_KEY. Change the environment variable and restart to
                  replace the key.
                </p>
              ) : keyConfigured ? (
                <p className="field-hint">A key is already saved. Enter a new key to replace it.</p>
              ) : null}
              {fieldErrors.steamApiKey !== undefined && fieldErrors.steamApiKey !== "" && (
                <p className="field-error" id="api-key-error">
                  {fieldErrors.steamApiKey}
                </p>
              )}
            </div>
          </div>
        </li>

        <li className="setup-step">
          <span className="step-number" aria-hidden="true">
            4
          </span>
          <div className="setup-step-body">
            <h3>Scan</h3>
            <p>
              Scan saves the key and starts the first <strong>all</strong> + Fetch. Closing the
              browser after this point is safe; the run continues on the server.
            </p>
            <div className="setup-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void startScan()}
                disabled={scanning}
              >
                {scanning ? "Starting…" : "Scan library"}
              </button>
              {status?.activeRefresh !== null && status?.activeRefresh !== undefined && (
                <span className="field-hint" role="status">
                  A Refresh is already running.
                </span>
              )}
            </div>
          </div>
        </li>
      </ol>

      <footer className="onboarding-foot">
        game-cat reads local Steam files and never writes to Steam.
      </footer>
    </section>
  );
}
