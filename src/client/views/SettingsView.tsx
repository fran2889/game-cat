import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import {
  Alert,
  Anchor,
  Box,
  Button,
  Checkbox,
  Code,
  DataList,
  Fieldset,
  Group,
  NativeSelect,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { ApiError, patchConfig, steamAccountsQueryOptions, type ConfigPatch } from "../api.ts";
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
  const accountsQuery = useQuery(steamAccountsQueryOptions);
  const accounts = accountsQuery.data ?? [];
  const saveMutation = useMutation({ mutationFn: patchConfig });
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

  if (config === null) {
    return (
      <Box component="section" className="settings" aria-busy="true">
        <Text>Loading settings…</Text>
      </Box>
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
      const result = await saveMutation.mutateAsync(patch);
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
    <Stack component="section" className="settings" aria-labelledby="settings-heading" gap="md">
      <Paper component="header" className="settings-head" p="lg" radius="lg" withBorder>
        <Stack gap={4}>
          <Text size="xs" c="gray.5" tt="uppercase" fw={700}>
            Settings
          </Text>
          <Title order={2} id="settings-heading">
            Configuration
          </Title>
          <Text c="gray.5">
            game-cat reads these settings from the data directory. Secrets are write-only and are
            never shown here.
          </Text>
        </Stack>
      </Paper>

      <DataList className="settings-facts" orientation="vertical" gap="sm">
        <DataList.Item>
          <DataList.ItemLabel c="gray.5">Data directory</DataList.ItemLabel>
          <DataList.ItemValue>
            <Code>{config.dataDir}</Code>
          </DataList.ItemValue>
        </DataList.Item>
        <DataList.Item>
          <DataList.ItemLabel c="gray.5">Listening URL</DataList.ItemLabel>
          <DataList.ItemValue>
            <Code>{config.listeningUrl}</Code>
          </DataList.ItemValue>
        </DataList.Item>
        <DataList.Item>
          <DataList.ItemLabel c="gray.5">Steam Web API key</DataList.ItemLabel>
          <DataList.ItemValue>
            {config.steamApiKeySet ? "Configured" : "Not configured"} ·{" "}
            {KEY_SOURCE_LABEL[config.steamApiKeySource] ?? config.steamApiKeySource}
          </DataList.ItemValue>
        </DataList.Item>
        <DataList.Item>
          <DataList.ItemLabel c="gray.5">Selected Account</DataList.ItemLabel>
          <DataList.ItemValue>
            {status?.steam.account === null || status?.steam.account === undefined
              ? "No Steam Account selected"
              : `${status.steam.account.personaName} · ${status.steam.account.steamId64}`}
          </DataList.ItemValue>
        </DataList.Item>
      </DataList>

      {formError !== null && (
        <Alert color="red" variant="light" role="alert" title="The settings are not saved.">
          <Text size="sm">{formError}</Text>
        </Alert>
      )}

      {restartRequired === true && (
        <Alert color="yellow" variant="light" role="status" title="Restart required.">
          <Text size="sm">
            The listening socket does not move until the next start. The current address is{" "}
            <Code>{config.listeningUrl}</Code>; after restart game-cat will listen on the new port.
          </Text>
        </Alert>
      )}

      <Box
        component="form"
        className="settings-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Stack gap="md">
          <Fieldset legend="Steam">
            <Stack gap="md">
              <TextInput
                id="settings-steam-root"
                label="Steam root"
                value={steamRoot}
                autoComplete="off"
                aria-invalid={fieldErrors.steamRoot !== undefined}
                error={fieldErrors.steamRoot}
                onChange={(event) => setSteamRoot(event.currentTarget.value)}
                description="A configured path is authoritative. A missing folder is reported, not replaced by auto-discovery."
              />

              <NativeSelect
                id="settings-account"
                label="Steam Account"
                value={steamId64}
                error={fieldErrors.steamId64}
                data={
                  accountOptions.length === 0
                    ? [{ value: "", label: "No Account detected" }]
                    : accountOptions.map((account) => ({
                        value: account.steamId64,
                        label: `${account.personaName} · ${account.steamId64}`,
                      }))
                }
                onChange={(event) => setSteamId64(event.currentTarget.value)}
                description="Switching Accounts requires a new data directory. AccountName is never shown."
              />

              <PasswordInput
                id="settings-api-key"
                label="Steam Web API key"
                value={apiKey}
                placeholder={config.steamApiKeySet ? "•••••••• (saved)" : "Paste your key"}
                autoComplete="off"
                disabled={envManaged}
                error={fieldErrors.steamApiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
                description={
                  <>
                    {envManaged
                      ? "Managed by GAME_CAT_STEAM_API_KEY. Change the environment variable and restart to replace the key."
                      : "Write-only. Leave blank to keep the saved key."}{" "}
                    <Anchor href={API_KEY_URL} target="_blank" rel="noopener noreferrer">
                      Get a Steam Web API key
                    </Anchor>
                  </>
                }
              />
            </Stack>
          </Fieldset>

          <Fieldset legend="Server">
            <Stack gap="md">
              <Box className="settings-row">
                <TextInput
                  id="settings-port"
                  label="Port"
                  type="number"
                  min={0}
                  max={65535}
                  value={port}
                  aria-invalid={fieldErrors.port !== undefined}
                  error={fieldErrors.port}
                  onChange={(event) => setPort(event.currentTarget.value)}
                  description="0 asks the OS for a free port. A port change takes effect on the next start."
                />

                <NativeSelect
                  id="settings-log-level"
                  label="Log level"
                  value={logLevel}
                  data={LOG_LEVELS.map((level) => ({ value: level, label: level }))}
                  onChange={(event) => setLogLevel(event.currentTarget.value)}
                  description="Applies immediately."
                />
              </Box>

              <Checkbox
                size="md"
                styles={{ input: { width: 24, height: 24 } }}
                label="Open the browser on the next start"
                checked={openBrowser}
                onChange={(event) => setOpenBrowser(event.currentTarget.checked)}
              />
            </Stack>
          </Fieldset>

          <Group className="settings-actions" gap="sm">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
            {restartRequired === false && (
              <Text size="xs" c="gray.5" role="status">
                Settings saved. No restart required.
              </Text>
            )}
          </Group>
        </Stack>
      </Box>
    </Stack>
  );
}
