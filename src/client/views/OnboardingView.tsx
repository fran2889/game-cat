import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Paper,
  PasswordInput,
  Radio,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
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

function StepNumber({ value }: { value: number }) {
  return (
    <ThemeIcon radius="xl" variant="light" aria-hidden="true">
      {value}
    </ThemeIcon>
  );
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
    <Stack component="section" className="onboarding" aria-labelledby="onboarding-heading" gap="md">
      <Paper component="header" className="onboarding-head" p="lg" radius="lg" withBorder>
        <Group align="flex-start" gap="md" wrap="nowrap">
          <ThemeIcon color="yellow" variant="light" size={46} radius="md" aria-hidden="true">
            <Text component="span" fw={800} size="sm" c="yellow.4">
              GC
            </Text>
          </ThemeIcon>
          <Stack gap={4}>
            <Text size="xs" c="gray.5" tt="uppercase" fw={700}>
              Setup
            </Text>
            <Title order={2} id="onboarding-heading">
              Connect your Steam library
            </Title>
            <Text c="gray.5">
              Steam folder, Account, and a Steam Web API key are all this setup needs. The first
              Fetch starts only after you choose Scan.
            </Text>
          </Stack>
        </Group>
      </Paper>

      {ambiguousAccount && (
        <Alert
          color="yellow"
          variant="light"
          role="status"
          data-testid="ambiguous-account"
          title="Several Steam Accounts were found."
        >
          <Group gap="sm" justify="space-between" wrap="wrap">
            <Text size="sm">
              game-cat selected the most recently used Account. Confirm the right one below before
              scanning; the picker stays available here and in Settings.
            </Text>
            <Button component="a" href="#steam-account" variant="default">
              Choose Account
            </Button>
          </Group>
        </Alert>
      )}

      {invalidKey && (
        <Alert color="red" variant="light" role="alert" title="Steam rejected the Web API key.">
          <Group gap="sm" justify="space-between" wrap="wrap">
            <Text size="sm">
              Enter a new key below and Scan again. Your cached Library was kept and nothing was
              deleted.
            </Text>
            <Button variant="default" onClick={() => void retry()}>
              Retry
            </Button>
          </Group>
        </Alert>
      )}

      {emptyRoster && (
        <Alert color="yellow" variant="light" role="status" title="Steam returned no owned Games.">
          <Stack gap="sm">
            <Text size="sm">
              If this Account owns Games, its Steam profile may be private. Local evidence is kept;
              game-cat cannot claim the Library is complete.
            </Text>
            <Group gap="xs" wrap="wrap">
              <Button variant="default" onClick={() => void retry()}>
                Retry
              </Button>
              <Button component="a" href="#api-key" variant="default">
                Fix API key
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      {formError !== null && (
        <Alert color="red" variant="light" role="alert" title="The setup is not saved yet.">
          <Text size="sm">{formError}</Text>
        </Alert>
      )}

      <Stack
        component="ol"
        className="onboarding-steps"
        gap="sm"
        style={{ listStyle: "none", padding: 0, margin: 0 }}
      >
        <Paper component="li" className="setup-step" p="md" radius="md" withBorder>
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <StepNumber value={1} />
            <Stack className="setup-step-body" gap="sm" style={{ flex: 1, minWidth: 0 }}>
              <Title order={3} size="h5">
                Steam folder
              </Title>
              {steamMissing ? (
                <Text size="sm" c="gray.5">
                  Steam was not found at the configured path. Install or start Steam, then recheck.
                  You can also enter the folder manually.
                </Text>
              ) : (
                <Text size="sm" c="gray.5">
                  game-cat found your local Steam installation. Change the path if needed.
                </Text>
              )}

              {editingRoot ? (
                <Stack gap="xs">
                  <Group align="flex-end" gap="xs" wrap="nowrap">
                    <TextInput
                      id="steam-root"
                      label="Steam root"
                      value={steamRoot}
                      autoComplete="off"
                      style={{ flex: 1 }}
                      aria-invalid={fieldErrors.steamRoot !== undefined}
                      error={fieldErrors.steamRoot}
                      onChange={(event) => setSteamRoot(event.currentTarget.value)}
                    />
                    <Button variant="default" onClick={() => confirmRoot()}>
                      Use this folder
                    </Button>
                  </Group>
                </Stack>
              ) : (
                <Group className="setup-value" gap="sm" wrap="wrap">
                  <Code>{steamRoot === "" ? "No Steam folder detected" : steamRoot}</Code>
                  <Badge color={steamMissing ? "red" : "green"} variant="light" tt="none">
                    {steamMissing ? "Not found" : steamRoot === "" ? "Not detected" : "Detected"}
                  </Badge>
                  <Button variant="default" onClick={() => setEditingRoot(true)}>
                    Change
                  </Button>
                </Group>
              )}
            </Stack>
          </Group>
        </Paper>

        <Paper
          component="li"
          id="steam-account"
          className="setup-step"
          p="md"
          radius="md"
          withBorder
        >
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <StepNumber value={2} />
            <Stack className="setup-step-body" gap="sm" style={{ flex: 1, minWidth: 0 }}>
              <Title order={3} size="h5">
                Steam Account
              </Title>
              {noAccount || accounts.length === 0 ? (
                <Text size="sm" c="gray.5">
                  No Steam Account was detected. Start Steam and sign in once, then recheck. An
                  Account choice is required before Steam can return an owned-games roster.
                </Text>
              ) : (
                <Text size="sm" c="gray.5">
                  The selected Account is shown as PersonaName and SteamID64.
                </Text>
              )}

              {accounts.length > 1 ? (
                <Radio.Group
                  label="Choose a Steam Account"
                  value={selectedSteamId64}
                  onChange={setSelectedSteamId64}
                >
                  <Stack gap={4} mt="xs">
                    {accounts.map((account) => (
                      <Radio
                        key={account.steamId64}
                        value={account.steamId64}
                        label={
                          <Group gap="xs" wrap="nowrap">
                            <Text component="span" fw={600}>
                              {account.personaName}
                            </Text>
                            <Text component="span" size="xs" c="gray.5">
                              {account.steamId64}
                            </Text>
                          </Group>
                        }
                      />
                    ))}
                  </Stack>
                </Radio.Group>
              ) : selectedAccount !== null ? (
                <Group className="setup-value" gap="sm">
                  <Text fw={600}>{selectedAccount.personaName}</Text>
                  <Text size="xs" c="gray.5">
                    {selectedAccount.steamId64}
                  </Text>
                </Group>
              ) : null}

              <Group className="setup-actions" gap="sm" align="center">
                <Button variant="default" onClick={() => void accountsQuery.refetch()}>
                  Recheck accounts
                </Button>
                {accountsError !== null && (
                  <Text className="field-error" size="sm" c="red">
                    {accountsError}
                  </Text>
                )}
              </Group>
            </Stack>
          </Group>
        </Paper>

        <Paper component="li" className="setup-step" p="md" radius="md" withBorder>
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <StepNumber value={3} />
            <Stack className="setup-step-body" gap="sm" style={{ flex: 1, minWidth: 0 }}>
              <Title order={3} size="h5">
                Steam Web API key
              </Title>
              <Text size="sm" c="gray.5">
                Required for the owned-games roster. game-cat never verifies the key until the first
                Fetch, and never sends the key to the browser after it is saved.
              </Text>
              <Stack gap="xs">
                <PasswordInput
                  id="api-key"
                  label="Steam Web API key"
                  value={apiKey}
                  placeholder={keyConfigured ? "•••••••• (saved)" : "Paste your key"}
                  autoComplete="off"
                  disabled={envManaged}
                  required={!keyConfigured && !envManaged}
                  aria-required={!keyConfigured && !envManaged}
                  aria-invalid={fieldErrors.steamApiKey !== undefined}
                  error={fieldErrors.steamApiKey}
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                />
                <Group gap="xs" wrap="wrap">
                  <Anchor href={API_KEY_URL} target="_blank" rel="noopener noreferrer">
                    Get a Steam Web API key
                  </Anchor>
                </Group>
                {envManaged ? (
                  <Text size="xs" c="gray.5">
                    Managed by GAME_CAT_STEAM_API_KEY. Change the environment variable and restart
                    to replace the key.
                  </Text>
                ) : keyConfigured ? (
                  <Text size="xs" c="gray.5">
                    A key is already saved. Enter a new key to replace it.
                  </Text>
                ) : null}
              </Stack>
            </Stack>
          </Group>
        </Paper>

        <Paper component="li" className="setup-step" p="md" radius="md" withBorder>
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <StepNumber value={4} />
            <Stack className="setup-step-body" gap="sm" style={{ flex: 1, minWidth: 0 }}>
              <Title order={3} size="h5">
                Scan
              </Title>
              <Text size="sm" c="gray.5">
                Scan saves the key and starts the first <strong>all</strong> + Fetch. Closing the
                browser after this point is safe; the run continues on the server.
              </Text>
              <Group className="setup-actions" gap="sm" align="center">
                <Button onClick={() => void startScan()} disabled={scanning}>
                  {scanning ? "Starting…" : "Scan library"}
                </Button>
                {status?.activeRefresh !== null && status?.activeRefresh !== undefined && (
                  <Text size="xs" c="gray.5" role="status">
                    A Refresh is already running.
                  </Text>
                )}
              </Group>
            </Stack>
          </Group>
        </Paper>
      </Stack>

      <Paper className="onboarding-foot" component="footer" p="sm" radius="md" withBorder>
        <Text size="sm" c="gray.5" ta="center">
          game-cat reads local Steam files and never writes to Steam.
        </Text>
      </Paper>
    </Stack>
  );
}
