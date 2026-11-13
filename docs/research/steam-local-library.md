# Steam local library: file formats and discovery

Status: research note for game-cat v1. Read-only findings; no Steam file was modified.
Scope: what game-cat reads from a local Steam installation, and how it finds it.

## 0. Method and evidence standard

Steam was **not installed** in the environment where this note was written. `~/.steam`,
`~/.local/share/Steam`, `~/Library/Application Support/Steam` and
`~/.var/app/com.valvesoftware.Steam` do not exist there, so no live files could be inspected.

Evidence therefore comes from three kinds of sources, labelled in the text:

- **[Valve code]** Valve-authored source: `KeyValues.h` in the public Source SDK 2013. This is
  Valve's own description of the VDF text format. <https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/public/tier1/KeyValues.h>
- **[real file]** Real Steam files published in public repositories (bug reports, backup tools,
  game-server repos). Every ID, account name and path below is redacted or replaced; the shapes
  and field names are quoted as published.
- **[impl]** Mature open-source implementations that read these files: steamlocate, GameFinder,
  Depressurizer, SteamTinkerLaunch, BoilR, ChimeraOS, vapourfly, gib, SamRewritten.

Valve's developer wiki (`developer.valvesoftware.com`) and `partner.steamgames.com` were not
reachable from this sandbox (the network policy blocked those hosts). Where a canonical Valve
page exists, its URL is given as **unverified here**; no claim in this note rests on it alone.
Anything that still needs confirmation against a live install is listed in §10.

All SteamID64 values and account names in samples are placeholders (`7656119XXXXXXXXXX`,
`redacted`). No tokens, credentials or personal data are reproduced.

## 1. What game-cat reads, in one table

| Data | File | Required for v1? |
|---|---|---|
| Steam root, library folders | `config/libraryfolders.vdf` (older: `steamapps/libraryfolders.vdf`) | yes |
| Accounts on this machine, active account | `config/loginusers.vdf` | yes |
| Installed games, install dir, size, state | `<library>/steamapps/appmanifest_<appid>.acf` | yes |
| Playtime, last played, launch options | `userdata/<accountid>/config/localconfig.vdf` | yes |
| Collections, hidden/favorites | `userdata/<accountid>/config/cloudstorage/cloud-storage-namespace-1.json` | yes |
| Legacy categories (pre-2019) | `userdata/<accountid>/7/remote/sharedconfig.vdf` | no (compat only) |
| Names for apps without a manifest | `appcache/appinfo.vdf`, `userdata/<id>/config/librarycache/librarycache.json` | no |

The important scope correction: **`localconfig.vdf` is not where current collections live.**
It holds playtime and last-played per app. Collections live in the Steam Cloud storage cache
(§6); legacy categories live in `sharedconfig.vdf` (§6.4). See §6 for the full history.

## 2. Where Steam lives

### 2.1 Platform paths

Steam's *install root* (the directory containing `steamapps/`) is not the same as its *data root*
on every platform, and `userdata/` sits under the install root.

| Platform | Candidate install roots (probe in order) | Confidence |
|---|---|---|
| Linux | `$XDG_DATA_HOME/Steam` (usually `~/.local/share/Steam`) | [impl] steamlocate, GameFinder |
| Linux | `~/.steam/root`, `~/.steam/steam`, `~/.steam/debian-installation` | [impl] steamlocate, gib (`~/.steam/root`) |
| Linux (Flatpak) | `~/.var/app/com.valvesoftware.Steam/data/Steam`, `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`, `~/.var/app/com.valvesoftware.Steam/.steam/{steam,root}` | [impl] steamlocate, GameFinder |
| Linux (Snap) | `~/snap/steam/common/.local/share/Steam`, `.../.steam/{steam,root}` | [impl] steamlocate |
| macOS | `~/Library/Application Support/Steam` | [impl] steamlocate, GameFinder, gib, prior-art note |
| macOS (CrossOver/Wine) | `~/Library/Application Support/CrossOver/Bottles/*/drive_c/<Program Files>/Steam` | [impl] steamlocate (`macos.rs`) |
| Windows | `HKCU\Software\Valve\Steam` value `SteamPath` | [impl] GameFinder, gib (protocol handler), vapourfly |
| Windows | `HKLM\SOFTWARE\WOW6432Node\Valve\Steam` value `InstallPath` (64-bit: `SOFTWARE\Valve\Steam`) | [impl] steamlocate (`windows.rs`) |
| Windows | `%ProgramFiles(x86)%\Steam`, then `C:\Program Files (x86)\Steam` | [impl] steamlocate, GameFinder, vapourfly |

Additional Windows signal: the `steam://` URL protocol handler
(`HKCR\steam\shell\open\command`) resolves to `steam.exe`; its parent directory is the install
root. This catches custom and portable installs that registry keys miss ([impl] gib
`src/utils/protocolHandler.ts`). macOS has the equivalent via `NSWorkspace` for `steam://`.

A directory is a **valid Steam root** if it contains `steamapps/` and a `libraryfolders.vdf`
(either `config/libraryfolders.vdf` or the older `steamapps/libraryfolders.vdf`) — this is the
validity test used by GameFinder (`SteamLocationFinder.IsValidSteamInstallation`). Directory
existence alone is not enough: Flatpak leaves empty `~/.var/app/.../.steam` skeletons behind
after uninstall.

### 2.2 Libraries other than the default

Steam supports multiple library folders on different disks. They are recorded in a VDF file:

- Modern: `<steam-root>/config/libraryfolders.vdf`
- Older: `<steam-root>/steamapps/libraryfolders.vdf`

Both use the same schema since the 2021 format change [real file] (the block below is a
composite: a second library and the inline `apps` entries are illustrative; real files put one
App ID per line):

```vdf
"libraryfolders"
{
	"0"
	{
		"path"		"/home/redacted/.local/share/Steam"
		"label"		""
		"contentid"		"370408126354861628"
		"totalsize"		"0"
		"update_clean_bytes_tally"		"2148248516"
		"time_last_update_verified"		"1776809549"
		"apps" { "22330" "5987389233" "228980" "1068439499" }
	}
	"1"
	{
		"path"		"/mnt/games/SteamLibrary"
		"label"		""
		"contentid"		"..."
		"apps" { }
	}
}
```

- Numeric top-level keys are library slots; metadata keys (`TimeNextStatsReport`,
  `ContentStatsID`) must be ignored. Iterate keys that are all digits and read `path`
  [impl] steamlocate `library.rs`, vapourfly `paths.rs`.
- `path` is an absolute path, with native separators (Windows paths appear as `M:\\Steam`).
- The Steam root itself is always an implicit library even if the file is missing or lists only
  one entry [impl] vapourfly.
- `apps` maps App ID → installed size in bytes; it can be stale. Scan the `steamapps/`
  directory for `appmanifest_*.acf` instead of trusting this map [impl] steamlocate comment.

Old (pre-2021) schema, still found on machines that have not run a modern client:

```vdf
"LibraryFolders"
{
	"TimeNextStatsReport"	"1234567890"
	"ContentStatsID"	"-1234567890123456789"
	"1"		"D:\\SteamLibrary"
}
```

Here library slots are strings, not objects. Handle both: if a numeric key's value is a string,
treat it as a path; if it is an object, read its `path`. (Old-schema shape is widely described
in community tooling; I did not find a preserved real sample in this pass, so treat it as
defensive handling rather than a confirmed current format.)

**Portable installs.** A Windows "portable" Steam is just an install root outside
`Program Files`, often on a removable drive, with `steam.exe` at the top and `steamapps/` beside
it. There is no portable marker file; discovery must come from the protocol handler, a
user-supplied path, or an explicit scan of user-chosen roots. Do **not** recursively scan whole
disks. The same structure test (`steamapps/` + `libraryfolders.vdf`) validates it.

### 2.3 Discovery order

1. Explicit override from game-cat config (`steamRoot`), if set — highest priority, always.
2. Platform default candidates from §2.1, in order, first one that passes the structure test.
3. Windows only: registry keys, then protocol handler, then Program Files fallback.
4. If none pass: report "Steam not found" and offer a folder picker; do not guess.

Resolve symlinks (`~/.steam/steam` is usually a symlink into the real root) and de-duplicate by
resolved path. On Linux `~/.steam/root` and `~/.local/share/Steam` are frequently the same
directory.

## 3. `loginusers.vdf` — accounts and the active account

Path: `<steam-root>/config/loginusers.vdf` (global, not per-user).

```vdf
"users"
{
	"7656119XXXXXXXXXX"          // SteamID64, one block per account that has logged in here
	{
		"AccountName"		"redacted"
		"PersonaName"		"redacted"
		"RememberPassword"	"1"
		"WantsOfflineMode"	"0"
		"SkipOfflineModeWarning"	"0"
		"AllowAutoLogin"	"1"
		"MostRecent"		"1"
		"Timestamp"		"1663423107"
	}
}
```

[real file] <https://github.com/baldsealion/Steamdeck-Ultimate-Windows11-Guide/blob/main/Steam%20Input%20Scripts/Original/loginusers.vdf>

| Field | Type | Meaning | Notes |
|---|---|---|---|
| block key | string | SteamID64 of the account | 17 digits, prefix `7656119...` |
| `AccountName` | string | login name | sensitive; never display by default |
| `PersonaName` | string | display name | may be empty |
| `RememberPassword` | `"0"`/`"1"` | credentials remembered | |
| `WantsOfflineMode` | `"0"`/`"1"` | start in offline mode | |
| `SkipOfflineModeWarning` | `"0"`/`"1"` | | |
| `AllowAutoLogin` | `"0"`/`"1"` | | |
| `MostRecent` | `"0"`/`"1"` | **the account Steam logged in last** | exactly one should be `1`; may be absent or duplicated |
| `Timestamp` | unix seconds | last login/remember time | not documented by Valve; do not use as the primary signal |

`MostRecent` is the field every implementation uses to pick "the user" ([impl]
SteamTinkerLaunch `fillLoginUsersCSV`, vapourfly `select_account`, gib `getMostRecentUser`).
SteamTinkerLaunch explicitly warns the value "should really only ever be 0 or 1".

### 3.1 SteamID64 → account ID (the `userdata/` folder name)

`userdata/` folders are named with the 32-bit account ID ("Steam3 ID"), not SteamID64:

```
account_id = steam_id64 - 76561197960265728
```

Example: `76561198000000000` → `39734272`. [impl] vapourfly `STEAM_ID64_BASE`, Depressurizer
`Steam.ToSteam3Id`, GameFinder `SteamId.AccountId`; SteamTinkerLaunch implements the same
truncation with `& 0xFFFFFFFF` and calls the result the "Short UserID".

Defensive handling: some backups and fixtures name the folder with the full SteamID64. Try the
account ID first, then SteamID64, and accept whichever directory actually contains
`config/localconfig.vdf` or `config/cloudstorage/` [impl] vapourfly `resolve_userdata_dir`.

### 3.2 Selecting the account (recommended)

```
accounts = parse(loginusers.vdf).users
if config.accountId:                     # user pinned an account in game-cat
    return accounts[config.accountId]    # error if absent
if count(accounts) == 1: return it
active = accounts where MostRecent == "1"
if count(active) == 1: return active[0]
if count(active) > 1:  # ambiguous, pick newest Timestamp but surface a warning
    return max(active, key=Timestamp)
return newest(accounts, key=Timestamp)  # or ask the user
```

Rules that matter more than the exact order:

- Account choice must be **visible and overrideable** in the UI. "The user" is genuinely
  ambiguous on a shared machine.
- `loginusers.vdf` only lists accounts that have logged in *on this machine*. It is not the
  account's friend list, and it does not list family members.
- A game installed by a different account (Family Sharing) still appears in `steamapps/` with
  `LastOwner` set to the owning SteamID. Do not filter manifests by `LastOwner` unless the spec
  explicitly wants "my games only" — see §9.

## 4. `localconfig.vdf` — playtime, last played, legacy collection blob

Path: `<steam-root>/userdata/<account-id>/config/localconfig.vdf`

```vdf
"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"Apps"                       // also seen as "apps" — case varies by client version
				{
					"730"
					{
						"LastPlayed"		"1620104440"
						"Playtime"		"3602"          // minutes
						"Playtime2wks"		"167"           // minutes, rolling 2 weeks
						"PlaytimeDisconnected"	"3"
						"autocloud" { "lastlaunch" "1620104396" "lastexit" "1620104439" }
						"BadgeData"		"020000000800"
						"LaunchOptions"		""
					}
				}
				"LastPlayedTimesSyncTime"	"1620104440"
				"PlayerLevel"		"0"
				"user-collections"	"{}"      // optional legacy JSON blob, often empty
			}
		}
	}
	"Licenses"
	{
		"0"			"01000000404d0b24..."   // opaque license blob
		"303386"		"01000000404d0b24..."   // key = package ID, not App ID
	}
}
```

[real file] <https://github.com/aman1931998/Auto-Boosting-CSGO/blob/master/userdata/nuke/config/localconfig.vdf>
(the `Apps` capitalisation, `Playtime`, `Playtime2wks`, `autocloud` and `LastPlayedTimesSyncTime`
above are from that file; `PlaytimeDisconnected` is from the vapourfly fixture [impl], and a
2026-era localconfig uses lowercase `apps` — see the `zbinstaller` fixture).

| Field | Unit / type | Meaning |
|---|---|---|
| app block key | App ID (string) | one block per app that has local state |
| `LastPlayed` | unix seconds, string | last launch; `"0"` or missing = never |
| `Playtime` | integer minutes | total playtime, truncated by Steam to whole minutes |
| `Playtime2wks` | integer minutes | rolling two-week window |
| `PlaytimeDisconnected` | integer minutes | playtime recorded while offline |
| `LastPlayedTimesSyncTime` | unix seconds | when Steam last reconciled playtime with the backend |
| `LaunchOptions` | string | user's launch arguments (could contain paths; do not surface raw by default) |
| `autocloud.lastlaunch` / `lastexit` | unix seconds | last session bounds |
| `BadgeData` | hex string | Steam's own encoding; ignore |
| `Licenses` | map packageID → opaque hex blob | owned packages; app IDs must be resolved through `appcache/packageinfo.vdf` (out of scope here) |

Notes and traps:

- **Key case is not stable.** Real files show `Software/Valve/Steam/Apps` (2021) and `apps`
  (modern); `Playtime` vs `playtime`. GameFinder looks for `Playtime`; vapourfly and SamRewritten
  look for `playtime`; gib wraps the parsed tree in a case-insensitive proxy. Parse and look up
  keys case-insensitively.
- Not every owned game appears. GameFinder's model documentation: "Games that the user hasn't
  played yet aren't listed." Do not treat localconfig as the ownership list.
- `Playtime` can be negative in real files; SamRewritten stores it as `i32` and filters
  negatives to "no playtime". Clamp negatives to 0 and record a data-quality warning.
- `user-collections` is a JSON **string** in the VDF (a map of collection id → collection).
  In a modern 2026 file it was observed as `"{}"` while the real collections were in
  `cloudstorage`. It is a legacy/cache surface, not the source of truth [real file];
  BoilR writes it "for any Steam version that still references it" [impl].
- `Licenses` is the only local signal for *ownership* without the Web API. Resolving it needs
  `appcache/packageinfo.vdf`, whose binary format is out of scope for this ticket.

## 5. `appmanifest_<appid>.acf` — installed state, size, install dir

Path: `<library>/steamapps/appmanifest_<appid>.acf`, one file per installed app, in **every**
library folder.

```acf
"AppState"
{
	"appid"		"730"
	"universe"		"1"                 // also seen as "Universe"
	"name"		"Counter-Strike 2"
	"StateFlags"		"4"
	"installdir"		"Counter-Strike Global Offensive"
	"LastUpdated"		"1787501367"      // unix seconds
	"LastPlayed"		"1787512893"      // unix seconds; optional, newer clients
	"SizeOnDisk"		"66024731334"     // bytes
	"StagingSize"		"0"
	"buildid"		"24828357"
	"LastOwner"		"7656119XXXXXXXXXX"
	"DownloadType"		"1"
	"UpdateResult"		"0"
	"BytesToDownload"	"0"
	"BytesDownloaded"	"0"
	"BytesToStage"		"0"
	"BytesStaged"		"0"
	"TargetBuildID"		"24828357"
	"AutoUpdateBehavior"	"0"
	"AllowOtherDownloadsWhileRunning"	"0"
	"ScheduledAutoUpdate"	"0"
	"InstalledDepots" { "731" { "manifest" "3607516601398500144" "size" "8" } }
	"SharedDepots" { "228980" "228980" }
	"UserConfig" { "language" "english" }
	"MountedConfig" { "language" "english" }
}
```

[real file] <https://github.com/piwas-21/cs2-apple-silicon/blob/main/docs/reference/appmanifest_730.acf.before>
(this is a real 2026 CS2 manifest, including the `LastPlayed` field; `SizeOnDisk` is 66 GB).
The sample above is a composite: `InstalledDepots` is shortened, and `SharedDepots` /
`AllowOtherDownloadsWhileRunning` are part of the general schema rather than that particular
file. Depot blocks may also carry `dlcappid`.

| Field | Unit / type | Use |
|---|---|---|
| `appid` | App ID string | canonical key; verify it matches the filename |
| `name` | string | display name (may be missing in partial manifests) |
| `StateFlags` | bitmask, string | installed state, see below |
| `installdir` | relative path | `<library>/steamapps/common/<installdir>` |
| `LastUpdated` | unix seconds | when content was last updated — **not** last played |
| `LastPlayed` | unix seconds | last launch, when present; newer clients write it |
| `SizeOnDisk` | bytes, 64-bit string | installed size; may be 0 while staging and goes stale if the user edits files |
| `StagingSize` | bytes | non-zero only during staging |
| `buildid`, `TargetBuildID` | Build ID | current vs pending build; unequal means an update is queued |
| `LastOwner` | SteamID64 | last account that installed/launched it; relevant for Family Sharing |
| `BytesToDownload`/`Downloaded`, `BytesToStage`/`Staged` | bytes | progress counters, 0 when idle |
| `ScheduledAutoUpdate` | unix seconds | 0 when none |
| `InstalledDepots` | map depotID → {manifest, size} | empty during a partial install; a practical "content present" check |
| `SharedDepots` | map depotID → appID | redistributables etc. |
| `UserConfig` / `MountedConfig` | object | per-app config such as language |

### 5.1 Interpreting `StateFlags`

`StateFlags` is a bitmask; values are published in community models ([impl] GameFinder
`Models/StateFlags.cs`, sourced from Lutris' `docs/steam.rst`) and used by Steam-family tools:

| Bit | Value | Meaning |
|---|---|---|
| 0 | 1 | Uninstalled |
| 1 | 2 | Update required |
| 2 | **4** | **Fully installed** |
| 3 | 8 | Encrypted |
| 4 | 16 | Locked |
| 5 | 32 | Files missing |
| 6 | 64 | App running |
| 7 | 128 | Files corrupt |
| 8 | 256 | Update running |
| 9 | 512 | Update paused |
| 10 | 1024 | Update started |
| 11 | 2048 | Uninstalling |
| 12 | 4096 | Backup running |
| 16 | 65536 | Reconfiguring |
| 17 | 131072 | Validating |
| 18 | 262144 | Adding files |
| 19 | 524288 | Preallocating |
| 20 | 1048576 | Downloading |
| 21 | 2097152 | Staging |
| 22 | 4194304 | Committing |
| 23 | 8388608 | Update stopping |

Practical definition for game-cat:

```
installed = (StateFlags & 4) == 4
         && <library>/steamapps/common/<installdir> is a directory
         && InstalledDepots is non-empty
```

Do not test `StateFlags == 4` exactly: 4 combined with "app running" (64) or "files missing"
(32) still means installed. `StateFlags == 1026` (2 + 1024) is a download in progress
([impl] steam09 constant). If a manifest exists but `& 4` is not set, the app is mid-operation;
treat it as "not (yet) installed" and re-read later.

## 6. Categories and collections — where they really live

This is the part where the ticket's premise and reality diverge, so it is worth stating the
history explicitly.

### 6.1 Current model: Steam Cloud collections (2019+)

Collections ("Favorites", "Hidden", user collections, tag-derived collections) are Steam Cloud
objects, locally cached as JSON:

```
<steam-root>/userdata/<account-id>/config/cloudstorage/cloud-storage-namespace-1.json
<steam-root>/userdata/<account-id>/config/cloudstorage/cloud-storage-namespace-1.modified.json
```

The base file is a JSON **array of `[key, entry]` pairs**:

```json
[
  ["user-collections.favorite", {
    "key": "user-collections.favorite",
    "timestamp": 1774229861,
    "value": "{\"id\":\"favorite\",\"name\":\"Favorites\",\"added\":[730,427520],\"removed\":[]}",
    "version": "1880"
  }],
  ["user-collections.uc-AbCdEf123", {
    "key": "user-collections.uc-AbCdEf123",
    "timestamp": 1774229861,
    "value": "{\"id\":\"uc-AbCdEf123\",\"name\":\"redacted\",\"added\":[730],\"removed\":[],\"filterSpec\":{}}",
    "version": "1880",
    "conflictResolutionMethod": "custom"
  }],
  ["user-collections.deleted-one", {
    "key": "user-collections.deleted-one", "timestamp": 1594214055,
    "is_deleted": true, "version": "942"
  }]
]
```

[impl/real-shape] vapourfly fixture, BoilR, ChimeraOS, Depressurizer, prior-art note.

Key rules:

- Only keys starting with `user-collections.` are collections.
- Skip entries with `is_deleted: true`.
- `entry.value` is a **double-encoded JSON string**; parse it a second time.
- Inner object: `{ id, name, added: number[], removed: number[], filterSpec?: object }`.
- `added` lists member App IDs. `removed` is an exclusion list, meaningful for
  `user-collections.from-tag-*` (membership derived from store tags, minus `removed`); for
  ordinary user collections it is usually empty. Compute `effective = added - removed` and keep
  the raw arrays for diagnostics [impl] vapourfly `read_user_collections`.
- Reserved ids: `favorite` (Favorites) and `hidden` (Hidden games). Treat them as collections,
  not as "categories".
- `uc-*` ids are user collections; `from-tag-*` are auto-generated from tags.
- `filterSpec` appears on dynamic collections. Its schema is not public; membership is computed
  by the Steam client and `added` may be empty. v1 should read `added` and flag dynamic
  collections as "unsupported" rather than inventing membership.
- `cloud-storage-namespace-1.modified.json` holds pending local changes. If present, merge it
  over the base file by key, preferring the modified entry; `.modified.json` may be transient or
  absent.

The prior-art note (`fran2889/steam-cat/docs/steam-local-collections.md`) reaches the same
conclusion, including the `.modified.json` merge rule. That note also records that on Linux
there is no LevelDB in front of these JSON files; the LevelDB under `htmlcache/` is the client's
Chromium cache.

### 6.2 Older model: same objects in a LevelDB

Before the flat JSON cache, the same namespace was stored in the Steam client's LevelDB under

```
<steam-root>/config/htmlcache/Local Storage/leveldb            (older clients)
<steam-root>/config/htmlcache/Default/Local Storage/leveldb    (newer CEF profiles)
```

with the key

```
_https://steamloopback.host\x00\x01U<account-id>-cloud-storage-namespace-1
```

and a value that is `\x01` followed by the JSON array described above ([impl] Depressurizer
`SteamLevelDB.cs`, BoilR, ChimeraOS `steam_collections.py`). LevelDB requires a lock; opening it
read-only while Steam runs is unsafe/impossible. Use it only as a fallback when the JSON file is
missing, and prefer to fail soft.

### 6.3 The `localconfig.vdf` blob

`Software/Valve/Steam/user-collections` in `localconfig.vdf` is a JSON string mapping
collection id → `{id, added, removed}` [impl] BoilR `parse_vdf_collection`. In a modern file it
was observed as `"{}"` [real file], so it is at best a stale mirror. Read it last, if at all,
and never let it override `cloudstorage`.

### 6.4 Legacy categories (`sharedconfig.vdf`)

Before the 2019 library rewrite, categories were per-app tags:

```vdf
"UserRoamingConfigStore"          // some copies are rooted "UserLocalConfigStore"
{
	"Software" { "Valve" { "Steam" { "apps"
	{
		"440"
		{
			"LastPlayed"	"1329308998"
			"tags" { "0" "FPS"  "1" "redacted" }
		}
	} } } }
}
```

[real file] <https://github.com/nfearnley/SteamCategories/blob/master/sharedconfig.vdf>

The shape is `apps/<appid>/tags/<index> = "<category name>"`; `apps/<appid>/hidden` is the old
hidden flag ([impl] Depressurizer `GameList.IntegrateFromNode`). File locations:

- `<steam-root>/userdata/<account-id>/7/remote/sharedconfig.vdf` (Steam Cloud "remote" copy)
- older clients may also carry the same `apps` tree inside `localconfig.vdf`; Depressurizer
  reads categories from `sharedconfig.vdf`, and none of the real `localconfig.vdf` samples
  inspected for this note contained a `tags` node. Treat a localconfig copy as possible but
  unconfirmed.

This system is superseded. A 2021 `sharedconfig.vdf` from a real install contained no `tags`
node at all [real file]. Steam's current UI does not show these tags, and a modern client will
not merge them into collections. For v1, read collections (§6.1); optionally surface legacy tags
as read-only "legacy category" labels if the spec wants compatibility with pre-2019 libraries.

Mapping in every model is the same: **a collection/category is a set of App IDs**, plus a name.
There is no stable cross-account category ID worth persisting; game-cat's own Smart Collections
must not reuse Steam's IDs.

## 7. Playtime and last-played: units, precision, rounding

| Value | Stored as | Unit | Source |
|---|---|---|---|
| Total playtime | `Playtime` (string) | **integer minutes** | localconfig |
| Recent playtime | `Playtime2wks` | integer minutes | localconfig |
| Offline playtime | `PlaytimeDisconnected` | integer minutes | localconfig |
| Last played | `LastPlayed` | **unix seconds** | localconfig, and `appmanifest` when present |
| Last content update | `LastUpdated` | unix seconds | appmanifest |
| Installed size | `SizeOnDisk` | **bytes**, 64-bit | appmanifest |
| Library app size | `apps.<appid>` in libraryfolders | bytes | libraryfolders.vdf |
| Library disk size | `totalsize` | bytes (often `0`) | libraryfolders.vdf |

Consequences:

- Steam has already truncated playtime to whole minutes; there is no sub-minute precision to
  recover. Store minutes as an integer (`u32`/`i64`), never as float hours.
- Render hours as `minutes / 60`, one decimal place, and **round only for display**. Filtering
  and sorting must use minutes (or seconds), otherwise 59 minutes and 61 minutes collapse into
  the same bucket.
- `LastPlayed` is authoritative to the second, but resolution in the client is one second; `"0"`
  means never. Do not show "played 0 seconds ago" for 0 — show "Never".
- The two `LastPlayed` values (manifest vs localconfig) can disagree: manifests survive a
  reinstall and localconfig can be older than the last launch. Take `max()` of the values that
  exist and record both.
- `LastUpdated` is not playtime. A game updated today but last played in 2023 must not sort as
  "recently played".
- `SizeOnDisk` is a snapshot from install/update time. GameFinder's model notes it is not
  updated when files change outside Steam, and is `0` while staging. Treat it as an estimate,
  not a filesystem measurement.
- Time zones: both timestamps are UTC epoch seconds. Convert at the edge; never store local time.

## 8. Failure modes and handling

| Failure | What you see | Recommended handling |
|---|---|---|
| Steam not installed | No candidate passes the `steamapps/` + `libraryfolders.vdf` test | Explicit "Steam not found" state, folder picker, no crash. Do not create Steam dirs. |
| Flatpak leftovers | `~/.var/app/com.valvesoftware.Steam/.steam` exists but is empty | Structure test rejects it; keep probing other candidates. |
| Never logged in | `config/loginusers.vdf` missing, or `users {}` empty | Installed games are still readable from manifests; playtime/collections are not. Show library with "no account" warning and disable account-scoped fields. |
| `loginusers.vdf` exists, `userdata/` empty | Account listed, no per-user dir | Account-scoped reads return empty; still show installed games. |
| No `MostRecent=1` | All `"0"` (or field absent) | Fall back to newest `Timestamp`, then to the only account; warn that selection was inferred. |
| Multiple `MostRecent=1` | Corrupt/hand-edited file | Pick newest `Timestamp`, warn, require confirmation before persisting a choice. |
| `MostRecent` points at a deleted account | `userdata/<id>` does not exist | Skip it, choose another account, warn. SteamTinkerLaunch hits exactly this case. |
| Malformed VDF (syntax) | Unterminated quote, missing `}` at EOF, stray token | Parser returns an error with file + line; skip that file, keep other sources. A truncated file with an unclosed object at EOF should be treated as suspect, not silently accepted. |
| Partially written VDF | File parses but required root key is missing (`AppState`, `users`, `UserLocalConfigStore`), or `appid` disagrees with filename | Validate the root name and the minimum required fields; reject the file and retry once. |
| Mid-update manifest | `StateFlags & 4 == 0`, `InstalledDepots` empty, `BytesToStage` non-zero | Treat as "installing/updating"; do not report as installed; re-read on next scan. |
| Steam writing while reading | Parse error or fields change between two reads | Read whole file into memory; `stat` before and after (`mtime`, `size`); if changed, retry up to 3 times with short backoff, then use the previous cached snapshot. Never hold the file open or mmap it. |
| File locked (Windows) | `EBUSY` / sharing violation | Open with full shared-read flags; retry; degrade to cached data. |
| LevelDB locked | `lock` error while Steam runs | Skip LevelDB path entirely; use the JSON cache. Never force-unlock. |
| `cloudstorage` absent | No `cloud-storage-namespace-1.json` | Collections unavailable; read legacy tags if present; otherwise empty collection list, no error state. |
| `cloudstorage` malformed/truncated | JSON parse error | Same as above; log file size and mtime, retry once. |
| `entry.value` malformed | Inner JSON fails | Skip that collection only; keep the rest. |
| Negative playtime | `-1` (or other negative) | Clamp to 0 and flag the app. |
| Playtime overflow | Very large values | Parse into 64-bit; minutes fit easily, but do not use 32-bit signed. |
| Non-UTF-8 bytes | Invalid sequences | Decode with replacement or fail the file; never crash the scan. Windows-1252 account names occur. |
| Case-changed keys | `Apps` vs `apps`, `Playtime` vs `playtime` | Case-insensitive lookup for all VDF keys. |
| Duplicate keys | e.g. two `playtime` entries in one app block | Keep the **last** occurrence (matches "later write wins") and log it; do not merge. |
| Permissions | `EACCES` on another user's `userdata` | Report "no access to account X", continue with what is readable. |
| Symlinked root | `~/.steam/steam` resolves elsewhere | Resolve realpath before de-duplicating libraries; keep the user-facing path for display. |

Two structural cautions:

- **Steam is not atomic across files.** It can rewrite `libraryfolders.vdf`, an appmanifest and
  a config at different moments. A scan is a point-in-time snapshot, not a transaction. Record a
  scan timestamp and expose "data as of" in the UI.
- **Read-only means read-only.** Never open a Steam file for write, never create lock files or
  temp files inside the Steam tree, and never "repair" a malformed file. If a write path is ever
  added (v3), it must be a separate, explicit, Steam-closed operation.

## 9. Recommended discovery algorithm

```
discoverSteamRoots(config):
    roots = []
    if config.steamRoot: roots.push(config.steamRoot)
    roots += platformCandidates()        # §2.1, in order
    if windows:
        roots.prepend(registrySteamPath())        # HKCU\Software\Valve\Steam\SteamPath
        roots.prepend(registryInstallPath())      # HKLM\...\Valve\Steam\InstallPath
        roots.prepend(protocolHandlerDir())       # steam:// -> steam.exe
    return dedupeByRealpath(roots).filter(looksLikeSteamInstall)

looksLikeSteamInstall(dir):
    return dir.exists()
        and (dir/steamapps).isDirectory()
        and ((dir/config/libraryfolders.vdf).exists()
             or (dir/steamapps/libraryfolders.vdf).exists())
```

```
scan(root):
    libraries = [root] + parseLibraryFolders(root)   # §2.2; ignore non-numeric keys
    libraries = libraries.filter(p => p/steamapps exists).dedupe()

    manifests = []
    for lib in libraries:
        for f in lib/steamapps/appmanifest_*.acf:
            m = tryParseAcf(f)                       # root must be "AppState"
            if m and m.appid == idFromFilename(f): manifests.push(m)

    accounts = tryParseLoginusers(root/config/loginusers.vdf)   # may be empty
    account  = selectAccount(accounts, config.accountId)        # §3.2

    userdata = root/userdata/<account.accountId or steamId64>  # first that exists
    local    = tryParseLocalConfig(userdata/config/localconfig.vdf)   # case-insensitive
    cloud    = tryParseCloudStorage(userdata/config/cloudstorage/
                                    cloud-storage-namespace-1.json,
                                    ...modified.json)          # §6.1

    games = {}
    for m in manifests: games[m.appid] = fromManifest(m)
    for appid, l in local.apps:
        games.getOrCreate(appid).playtimeMinutes = clamp0(l.Playtime)
        games[appid].lastPlayed  = max(nonzero(m.LastPlayed, l.LastPlayed))
        games[appid].playtime2wks = l.Playtime2wks
        games[appid].launchOptions = l.LaunchOptions
    for c in cloud.collections:
        games.attachCollection(c.id, c.name, effectiveIds(c))
    for g in games:
        g.installed = g.manifest != null
                   && (g.manifest.StateFlags & 4)
                   && exists(g.library/steamapps/common/g.manifest.installdir)
                   && g.manifest.InstalledDepots.nonEmpty()
    return snapshot(games, scannedAt = now, warnings = collectedWarnings)
```

Design notes for the spec:

- **Union, not intersection.** Installed apps come from manifests; playtime-only apps come from
  localconfig; collection-only IDs come from cloudstorage. A game can appear in any subset.
- **Ownership is a separate problem.** Local files do not enumerate every owned game. If v1's
  Library means "owned", the spec must either (a) accept installed ∪ played ∪ collection
  members ∪ `Licenses`-resolved packages, or (b) use the Steam Web API for ownership (which
  conflicts with the map's "local files, not Web API" decision). Record this as an explicit
  spec decision; do not let it emerge from the merge.
- **One account per scan.** Collections and playtime are account-scoped. If the user switches
  accounts, re-scan; do not merge two accounts' playtime.
- **Cache raw normalized records, not Steam's file contents.** Store appid, minutes, epoch
  seconds, collection membership and a scan timestamp. Do not mirror the VDF text (it contains
  account names and launch options).
- **Never write.** No code path in v1 opens a Steam file with a write flag.

## 10. What still needs verification on a real install

These are the load-bearing unknowns that this environment could not settle. Check them against a
live Linux, macOS and Windows install before the spec hardens:

1. Current key spelling and case in `localconfig.vdf`: `Playtime` vs `playtime`, `Apps` vs
   `apps`. (Both are attested; confirm which the current client writes.)
2. Presence and reliability of `appmanifest.LastPlayed` on current clients; whether all games get
   it or only recently launched ones.
3. Whether `localconfig.vdf`'s `user-collections` blob is ever populated by current clients, or
   is always `{}`.
4. Whether `cloud-storage-namespace-1.json` always exists after login, or only after opening the
   library UI once.
5. Exact `filterSpec` schema for dynamic collections and whether `added` is authoritative for
   them.
6. macOS: whether `config/` and `userdata/` live under `~/Library/Application Support/Steam` or
   under a `Steam/steamapps`-relative root in current builds.
7. Windows portable installs: whether the protocol handler is always registered and whether
   `SteamPath` is written for portable installs.
8. Whether legacy `sharedconfig.vdf` tags still exist on machines upgraded from pre-2019 Steam,
   and whether they are worth importing once.
9. Real file sizes/parse times for a 10k-game library (performance budget is a separate ticket).
10. Whether Steam ever writes these files without truncating first (affects retry tuning).

## 11. Sources

Valve:

- `KeyValues.h`, Source SDK 2013 — the authoritative description of the VDF text format
  (control characters, quoting, escapes, `#` macros, whitespace): <https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/public/tier1/KeyValues.h> (lines 49–62).
- Canonical (not reachable from this sandbox, listed for completeness):
  <https://developer.valvesoftware.com/wiki/KeyValues>,
  <https://developer.valvesoftware.com/wiki/Steam_Application_IDs>.

Reference implementations:

- steamlocate — platform discovery, `libraryfolders.vdf`, `steamapps` filtering:
  <https://github.com/WilliamVenner/steamlocate-rs> (`src/locate/{linux,windows,macos}.rs`, `src/library.rs`).
- GameFinder — typed models for `appmanifest`, `localconfig`, `libraryfolders`, `StateFlags`,
  Steam location finder: <https://github.com/erri120/GameFinder/tree/master/src/GameFinder.StoreHandlers.Steam>.
- vapourfly — cross-platform discovery, account selection, localconfig, collections, fixtures
  including malformed cases: <https://github.com/thedavidweng/vapourfly> (`crates/core/src/steam/`, `data/fixtures/`).
- Depressurizer — legacy categories, LevelDB collections, `sharedconfig.vdf` path:
  <https://github.com/Depressurizer/Depressurizer> (`src/Depressurizer.Core/Models/GameList.cs`, `SteamLevelDB.cs`).
- SteamTinkerLaunch — real-world Linux path probing, `loginusers.vdf` parsing and fallbacks:
  <https://github.com/sonic2kk/steamtinkerlaunch/blob/master/steamtinkerlaunch> (functions `setSteamPaths`, `fillLoginUsersCSV`).
- BoilR — cloudstorage JSON, LevelDB key format, localconfig `user-collections`:
  <https://github.com/PhilipK/BoilR/blob/master/crates/boilr-core/src/steam/collections.rs>.
- ChimeraOS — LevelDB collection store: <https://github.com/ChimeraOS/chimera/blob/master/chimera_app/steam_collections.py>.
- gib — `loginusers.vdf`, `localconfig.vdf`, `steam://` protocol handler discovery:
  <https://github.com/toebeann/gib/tree/master/src/launchers/steam>.
- SamRewritten — negative playtime handling: <https://github.com/PaulCombal/SamRewritten/blob/master/src/backend/local_config.rs>.
- Prior art in this project's predecessor: <https://github.com/fran2889/steam-cat/blob/master/docs/steam-local-collections.md>.

Real-file samples (IDs redacted in this note):

- `loginusers.vdf`: <https://github.com/baldsealion/Steamdeck-Ultimate-Windows11-Guide/blob/main/Steam%20Input%20Scripts/Original/loginusers.vdf>
- `localconfig.vdf` (2021, `Apps`/`Playtime`): <https://github.com/aman1931998/Auto-Boosting-CSGO/blob/master/userdata/nuke/config/localconfig.vdf>
- `localconfig.vdf` (2026, `apps`, `user-collections: "{}"`): <https://github.com/ipatavatsizz/zbinstaller/blob/main/tests/data/localconfig.vdf>
- `appmanifest_730.acf` (2026, includes `LastPlayed`): <https://github.com/piwas-21/cs2-apple-silicon/blob/main/docs/reference/appmanifest_730.acf.before>
- `libraryfolders.vdf` (modern schema): <https://github.com/Furglitch/modorganizer2-linux-installer/blob/master/docker/filesystem/home/docker/.local/share/Steam/steamapps/libraryfolders.vdf>
- `sharedconfig.vdf` (legacy `tags`): <https://github.com/nfearnley/SteamCategories/blob/master/sharedconfig.vdf>
- `cloud-storage-namespace-1.json` shape and malformed fixtures: <https://github.com/thedavidweng/vapourfly/tree/main/data/fixtures>
- `loginusers.vdf` / `localconfig.vdf` / `appmanifest` fixtures (synthetic): <https://github.com/T1nkiePlayz/Mochi/tree/main/src-tauri/fixtures>

Accessed 2026-11-13. Repository links point at default branches; pin commit SHAs when these
findings are promoted into the spec.
