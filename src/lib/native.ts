/**
 * Background functions for the native messenger interface
 */

import * as semverCompare from "semver-compare"
import * as config from "@src/lib/config"
import { browserBg, getContext } from "@src/lib/webext"

import Logger from "@src/lib/logging"
const logger = new Logger("native")

const NATIVE_NAME = "tridactyl"
type MessageCommand =
    | "version"
    | "run"
    | "read"
    | "write"
    | "writerc"
    | "temp"
    | "list_dir"
    | "mkdir"
    | "move"
    | "eval"
    | "getconfig"
    | "getconfigpath"
    | "env"
    | "win_firefox_restart"
interface MessageResp {
    cmd: string
    version: number | null
    content: string | null
    code: number | null
    error: string | null
}

/**
 * Posts using the one-time message API; native is killed after message returns
 */
async function sendNativeMsg(
    cmd: MessageCommand,
    opts: object,
    quiet = false,
): Promise<MessageResp> {
    const send = Object.assign({ cmd }, opts)
    let resp
    logger.info(`Sending message: ${JSON.stringify(send)}`)

    try {
        resp = await browserBg.runtime.sendNativeMessage(NATIVE_NAME, send)
        logger.info(`Received response:`, resp)
        return resp as MessageResp
    } catch (e) {
        if (!quiet) {
            throw new Error(
                "Failed to send message to native messenger. If it is correctly installed (run `:native`), please report this bug on https://github.com/tridactyl/tridactyl/issues .",
            )
        }
    }
}

export async function getrcpath(): Promise<string> {
    const res = await sendNativeMsg("getconfigpath", {})

    if (res.code !== 0) throw new Error("getrcpath error: " + res.code)

    return res.content
}

export async function getrc(): Promise<string> {
    const res = await sendNativeMsg("getconfig", {})

    if (res.content && !res.error) {
        logger.info(`Successfully retrieved fs config:\n${res.content}`)
        return res.content
    } else {
        // Have to make this a warning as async exceptions apparently don't get caught
        logger.info(`Error in retrieving config: ${res.error}`)
    }
}

export async function getNativeMessengerVersion(
    quiet = false,
): Promise<number> {
    const res = await sendNativeMsg("version", {}, quiet)
    if (res === undefined) {
        if (quiet) return undefined
        throw `Error retrieving version: ${res.error}`
    }
    if (res.version && !res.error) {
        logger.info(`Native version: ${res.version}`)
        return res.version
    }
}

export async function getBestEditor(): Promise<string> {
    let gui_candidates = []
    let term_emulators = []
    let tui_editors = []
    let last_resorts = []
    if ((await browserBg.runtime.getPlatformInfo()).os === "mac") {
        gui_candidates = [
            "/Applications/MacVim.app/Contents/bin/mvim -f",
            "/usr/local/bin/vimr --wait --nvim +only",
        ]
        // if anyone knows of any "sensible" terminals that let you send them commands to run,
        // please let us know in issue #451!
        term_emulators = [
            "/Applications/cool-retro-term.app/Contents/MacOS/cool-retro-term -e",
        ]
        last_resorts = ["open -nWt"]
    } else {
        // Tempted to put this behind another config setting: prefergui
        gui_candidates = ["gvim -f"]

        // we generally try to give the terminal the class "tridactyl_editor" so that
        // it can be made floating, e.g in i3:
        // for_window [class="tridactyl_editor"] floating enable border pixel 1
        term_emulators = [
            "st -c tridactyl_editor",
            "xterm -class tridactyl_editor -e",
            "uxterm -class tridactyl_editor -e",
            "urxvt -e",
            "alacritty -e", // alacritty is nice but takes ages to start and doesn't support class
            // Terminator and termite require  -e commands to be in quotes
            'terminator -u -e "%c"',
            'termite --class tridactyl_editor -e "%c"',
            "sakura --class tridactyl_editor -e",
            "lilyterm -e",
            "mlterm -e",
            "roxterm -e",
            "cool-retro-term -e",
            // Gnome-terminal doesn't work consistently, see issue #1035
            // "dbus-launch gnome-terminal --",

            // I wanted to put hyper.js here as a joke but you can't start it running a command,
            // which is a far better joke: a terminal emulator that you can't send commands to.
            // You win this time, web artisans.
        ]
        last_resorts = [
            "emacs",
            "gedit",
            "kate",
            "abiword",
            "sublime",
            "atom -w",
        ]
    }

    tui_editors = ["vim %f", "nvim %f", "nano %f", "emacs -nw %f"]

    // Consider GUI editors
    let cmd = await firstinpath(gui_candidates)

    if (cmd === undefined) {
        // Try to find a terminal emulator
        cmd = await firstinpath(term_emulators)
        if (cmd !== undefined) {
            // and a text editor
            const tuicmd = await firstinpath(tui_editors)
            if (cmd.includes("%c")) {
                cmd = cmd.replace("%c", tuicmd)
            } else {
                cmd = cmd + " " + tuicmd
            }
        } else {
            // or fall back to some really stupid stuff
            cmd = await firstinpath(last_resorts)
        }
    }

    return cmd
}

/**
 * Used internally to gate off functions that use the native messenger. Gives a
 * helpful error message in the command line if the native messenger is not
 * installed, or is the wrong version.
 *
 * @arg version: A string representing the minimal required version.
 * @arg interactive: True if a message should be displayed on version mismatch.
 * @return false if the required version is higher than the currently available
 * native messenger version.
 */
export async function nativegate(
    version = "0",
    interactive = true,
    desiredOS = ["mac", "win", "linux", "openbsd"],
    // desiredOS = ["mac", "win", "android", "cros", "linux", "openbsd"]
): Promise<boolean> {
    if (!desiredOS.includes((await browserBg.runtime.getPlatformInfo()).os)) {
        if (interactive) {
            logger.error(
                "# Tridactyl's native messenger doesn't support your operating system, yet.",
            )
        }
        return false
    }
    try {
        const actualVersion = await getNativeMessengerVersion()
        if (actualVersion !== undefined) {
            if (semverCompare(version, actualVersion) > 0) {
                if (interactive)
                    logger.error(
                        "# Please update to native messenger " +
                            version +
                            ", for example by running `:updatenative`.",
                    )
                // TODO: add update procedure and document here.
                return false
            }
            return true
        } else if (interactive)
            logger.error(
                "# Native messenger not found. Please run `:installnative` and follow the instructions.",
            )
        return false
    } catch (e) {
        if (interactive)
            logger.error(
                "# Native messenger not found. Please run `:installnative` and follow the instructions.",
            )
        return false
    }
}

export async function inpath(cmd) {
    const pathcmd =
        (await browserBg.runtime.getPlatformInfo()).os === "win"
            ? "where "
            : "which "
    return (await run(pathcmd + cmd.split(" ")[0])).code === 0
}

export async function firstinpath(cmdarray) {
    let ind = 0
    let cmd = cmdarray[ind]
    // Try to find a text editor
    while (!(await inpath(cmd.split(" ")[0]))) {
        ind++
        cmd = cmdarray[ind]
        if (cmd === undefined) break
    }
    return cmd
}

export async function editor(file: string, line: number, col: number, content?: string) {
    if (content !== undefined) await write(file, content)
    const editorcmd =
        (config.get("editorcmd") === "auto"
            ? await getBestEditor()
            : config.get("editorcmd"))
        .replace(/%l/, line)
        .replace(/%c/, col)
    let exec
    if (editorcmd.indexOf("%f") !== -1) {
        exec = await run(editorcmd.replace(/%f/, file))
    } else {
        exec = await run(editorcmd + " " + file)
    }
    if (exec.code != 0)
        return exec
    return read(file)
}

export async function read(file: string) {
    return sendNativeMsg("read", { file }).catch(e => {
        throw `Failed to read ${file}. ${e}`
    })
}

export async function write(file: string, content: string) {
    return sendNativeMsg("write", { file, content }).catch(e => {
        throw `Failed to write '${content}' to '${file}'. ${e}`
    })
}

export async function writerc(file: string, force: boolean, content: string) {
    return sendNativeMsg("writerc", { file, force, content }).catch(e => {
        throw `Failed to write '${content}' to '${file}'. ${e}`
    })
}

export async function mkdir(dir: string, exist_ok: boolean) {
    return sendNativeMsg("mkdir", { dir, exist_ok }).catch(e => {
        throw `Failed to create directory '${dir}'. ${e}`
    })
}

export async function temp(content: string, prefix: string) {
    return sendNativeMsg("temp", { content, prefix }).catch(e => {
        throw `Failed to write '${content}' to temp file '${prefix}'. ${e}`
    })
}

export async function move(from: string, to: string) {
    return sendNativeMsg("move", { from, to }).catch(e => {
        throw `Failed to move '${from}' to '${to}'. ${e}.`
    })
}

export async function listDir(dir: string) {
    return sendNativeMsg("list_dir", { path: dir }).catch(e => {
        throw `Failed to read directory '${dir}'. ${e}`
    })
}

export async function winFirefoxRestart(
    profiledir: string,
    browsercmd: string,
) {
    const required_version = "0.1.6"

    if (!(await nativegate(required_version, false))) {
        throw `'restart' on Windows needs native messenger version >= ${required_version}.`
    }

    return sendNativeMsg("win_firefox_restart", { profiledir, browsercmd })
}

export async function run(command: string, content = "") {
    const msg = await sendNativeMsg("run", { command, content })
    logger.info(msg)
    return msg
}

/** Evaluates a string in the native messenger. This has to be python code. If
 *  you want to run shell strings, use run() instead.
 */
export async function pyeval(command: string): Promise<MessageResp> {
    return sendNativeMsg("eval", { command })
}

export async function getenv(variable: string) {
    const required_version = "0.1.2"

    if (!(await nativegate(required_version, false))) {
        throw `'getenv' needs native messenger version >= ${required_version}.`
    }

    return (await sendNativeMsg("env", { var: variable })).content
}

/** Calls an external program, to either set or get the content of the X selection.
 *  When setting the selection or if getting it failed, will return an empty string.
 **/
export async function clipboard(
    action: "set" | "get",
    str: string,
): Promise<string> {
    let clipcmd = await config.get("externalclipboardcmd")
    if (clipcmd === "auto") clipcmd = await firstinpath(["xsel", "xclip"])

    if (clipcmd === undefined) {
        throw new Error("Couldn't find an external clipboard executable")
    }

    if (action === "get") {
        const result = await run(clipcmd + " -o")
        if (result.code !== 0) {
            throw new Error(
                `External command failed with code ${result.code}: ${clipcmd}`,
            )
        }
        return result.content
    } else if (action === "set") {
        const required_version = "0.1.7"
        if (await nativegate(required_version, false)) {
            const result = await run(`${clipcmd} -i`, str)
            if (result.code !== 0)
                throw new Error(
                    `External command failed with code ${
                        result.code
                    }: ${clipcmd}`,
                )
            return ""
        } else {
            // Fall back to hacky old fashioned way

            // We're going to pretend that we don't know about stdin, and we need to insert str, which we can't trust, into the clipcmd
            // In order to do this safely we'll use here documents:
            // http://pubs.opengroup.org/onlinepubs/009695399/utilities/xcu_chap02.html#tag_02_07_04

            // Find a delimiter that isn't in str
            let heredoc = "TRIDACTYL"
            while (str.search(heredoc) !== -1)
                heredoc += Math.round(Math.random() * 10)

            // Use delimiter to insert str into clipcmd's stdin
            // We use sed to remove the newline added by the here document
            clipcmd = `sed -z 's/.$//' <<'${heredoc}' | ${clipcmd} -i \n${str}\n${heredoc}`
            await run(clipcmd)
            return ""
        }
    }
    throw new Error("Unknown action!")
}

/** This returns the commandline that was used to start firefox.
 You'll get both firefox binary (not necessarily an absolute path) and flags */
export async function ff_cmdline(): Promise<string[]> {
    // Using ' and + rather that ` because we don't want newlines
    if ((await browserBg.runtime.getPlatformInfo()).os === "win") {
        throw `Error: "ff_cmdline() is currently broken on Windows and should be avoided."`
    } else {
        const output = await pyeval(
            'handleMessage({"cmd": "run", ' +
                '"command": "ps -p " + str(os.getppid()) + " -oargs="})["content"]',
        )
        return output.content.trim().split(" ")
    }
}

export async function parseProfilesIni(content: string, basePath: string) {
    const lines = content.split("\n")
    let current = "General"
    const result = {}
    for (const line of lines) {
        let match = line.match(/^\[([^\]]+)\]$/)
        if (match !== null) {
            current = match[1]
            result[current] = {}
        } else {
            match = line.match(/^([^=]+)=([^=]+)$/)
            if (match !== null) {
                result[current][match[1]] = match[2]
            }
        }
    }
    for (const profileName of Object.keys(result)) {
        const profile = result[profileName]
        // New profiles.ini have a useless section at the top
        if (profile.Path == undefined) {
            delete result[profileName]
            continue
        }
        // On windows, profiles.ini paths will be expressed with `/`, but we're
        // on windows, so we need `\`
        if ((await browserBg.runtime.getPlatformInfo()).os === "win") {
            profile.Path = profile.Path.replace("/", "\\")
        }
        // profile.IsRelative can be 0, 1 or undefined
        if (profile.IsRelative === "1") {
            profile.relativePath = profile.Path
            profile.absolutePath = basePath + profile.relativePath
        } else if (profile.IsRelative === "0") {
            if (profile.Path.substring(0, basePath.length) !== basePath) {
                throw new Error(
                    `Error parsing profiles ini: basePath "${basePath}" doesn't match profile path ${
                        profile.Path
                    }`,
                )
            }
            profile.relativePath = profile.Path.substring(basePath.length)
            profile.absolutePath = profile.Path
        }
    }
    return result
}

export async function getFirefoxDir() {
    switch ((await browserBg.runtime.getPlatformInfo()).os) {
        case "win":
            return getenv("APPDATA").then(path => path + "\\Mozilla\\Firefox\\")
        case "mac":
            return getenv("HOME").then(
                path => path + "/Library/Application Support/Firefox/",
            )
        default:
            return getenv("HOME").then(path => path + "/.mozilla/firefox/")
    }
}

export async function getProfileUncached() {
    const ffDir = await getFirefoxDir()
    const iniPath = ffDir + "profiles.ini"
    let iniObject = {}
    let iniSucceeded = false
    const iniContent = await read(iniPath)
    if (iniContent.code === 0 && iniContent.content.length > 0) {
        try {
            iniObject = await parseProfilesIni(iniContent.content, ffDir)
            iniSucceeded = true
        } catch (e) {}
    }
    const curProfileDir = config.get("profiledir")

    // First, try to see if the 'profiledir' setting matches a profile in profile.ini
    if (curProfileDir !== "auto") {
        if (iniSucceeded) {
            for (const profileName of Object.keys(iniObject)) {
                const profile = iniObject[profileName]
                if (profile.absolutePath === curProfileDir) {
                    return profile
                }
            }
        }
        return {
            Name: undefined,
            IsRelative: "0",
            Path: curProfileDir,
            relativePath: undefined,
            absolutePath: curProfileDir,
        }
    }

    // Then, try to find a profile path in the arguments given to Firefox
    const cmdline = await ff_cmdline().catch(e => "")
    let profile = cmdline.indexOf("--profile")
    if (profile === -1)
        profile = cmdline.indexOf("-profile")
    if (profile >= 0 && profile < cmdline.length - 1) {
        const profilePath = cmdline[profile + 1]
        if (iniSucceeded) {
            for (const profileName of Object.keys(iniObject)) {
                const profile = iniObject[profileName]
                if (profile.absolutePath === profilePath) {
                    return profile
                }
            }
        }
        // We're running in a profile that isn't stored in profiles.ini
        // Let's fill in the default info profile.ini profiles have anyway
        return {
            Name: undefined,
            IsRelative: "0",
            Path: profilePath,
            relativePath: undefined,
            absolutePath: profilePath,
        }
    }

    if (iniSucceeded) {
        // Try to find a profile name in firefox's arguments
        let p = cmdline.indexOf("-p")
        if (p === -1) p = cmdline.indexOf("-P")
        if (p >= 0 && p < cmdline.length - 1) {
            const pName = cmdline[p + 1]
            for (const profileName of Object.keys(iniObject)) {
                const profile = iniObject[profileName]
                if (profile.Name === pName) {
                    return profile
                }
            }
            throw new Error(
                `native.ts:getProfile() : '${
                    cmdline[p]
                }' found in command line arguments but no matching profile name found in "${iniPath}"`,
            )
        }
    }

    // Still nothing, try to find a profile in use
    let hacky_profile_finder = `find "${ffDir}" -maxdepth 2 -name lock`
    if ((await browserBg.runtime.getPlatformInfo()).os === "mac")
        hacky_profile_finder = `find "${ffDir}" -maxdepth 2 -name .parentlock`
    const profilecmd = await run(hacky_profile_finder)
    if (profilecmd.code === 0 && profilecmd.content.length !== 0) {
        // Remove trailing newline
        profilecmd.content = profilecmd.content.trim()
        // If there's only one profile in use, use that to find the right profile
        if (profilecmd.content.split("\n").length === 1) {
            const path = profilecmd.content
                .split("/")
                .slice(0, -1)
                .join("/")
            if (iniSucceeded) {
                for (const profileName of Object.keys(iniObject)) {
                    const profile = iniObject[profileName]
                    if (profile.absolutePath === path) {
                        return profile
                    }
                }
            }
            return {
                Name: undefined,
                IsRelative: "0",
                Path: path,
                relativePath: undefined,
                absolutePath: path,
            }
        }
    }

    if (iniSucceeded) {
        // Multiple profiles used but no -p or --profile, this means that we're using the default profile
        for (const profileName of Object.keys(iniObject)) {
            const profile = iniObject[profileName]
            if (profile.Default === 1 || profile.Default === "1") {
                return profile
            }
        }
    }

    throw new Error(
        `Couldn't deduce which profile you want. See ':help profiledir'`,
    )
}

// Disk operations are extremely slow on windows, let's cache our profile info
let cachedProfile
export async function getProfile() {
    if (cachedProfile === undefined)
        cachedProfile = await getProfileUncached()
    return cachedProfile
}
// It makes sense to pre-fetch this value in the background script because it's
// long-lived. Other contexts are created and destroyed all the time so we
// don't want to pre-fetch in these.
if (getContext() === "background") {
    getProfile()
}
config.addChangeListener("profiledir", (prev, cur) => {
    cachedProfile = undefined
    getProfile()
})

export function getProfileName() {
    return getProfile().then(p => p.Name)
}

export async function getProfileDir() {
    const profiledir = config.get("profiledir")
    if (profiledir !== "auto") return Promise.resolve(profiledir)
    return getProfile().then(p => p.absolutePath)
}

export async function parsePrefs(prefFileContent: string) {
    //  This RegExp currently only deals with " but for correctness it should
    //  also deal with ' and `
    //  We could also just give up on parsing and eval() the whole thing
    const regex = new RegExp(
        /^(user_|sticky_|lock)?[pP]ref\("([^"]+)",\s*"?([^\)]+?)"?\);$/,
    )
    // Fragile parsing
    return prefFileContent.split("\n").reduce((prefs, line) => {
        const matches = line.match(regex)
        if (!matches) {
            return prefs
        }
        const key = matches[2]
        let value = matches[3]
        // value = " means that it should be an empty string
        if (value === '"') value = ""
        prefs[key] = value
        return prefs
    }, {})
}

/** When given the name of a firefox preference file, will load said file and
 *  return a promise for an object the keys of which correspond to preference
 *  names and the values of which correspond to preference values.
 *  When the file couldn't be loaded or doesn't contain any preferences, will
 *  return a promise for an empty object.
 */
export async function loadPrefs(filename): Promise<{ [key: string]: string }> {
    const result = await read(filename)
    if (result.code !== 0) return {}
    return parsePrefs(result.content)
}

let cached_prefs = null

/** Returns a promise for an object that should contain every about:config
 *  setting.
 *
 *  Performance is slow so we need to cache the results.
 */
export async function getPrefs(): Promise<{ [key: string]: string }> {
    if (cached_prefs !== null) return cached_prefs
    const profile = (await getProfileDir()) + "/"
    const prefFiles = [
        // Debian has these
        "/usr/share/firefox/browser/defaults/preferences/firefox.js",
        "/usr/share/firefox/browser/defaults/preferences/debugger.js",
        "/usr/share/firefox/browser/defaults/preferences/devtools-startup-prefs.js",
        "/usr/share/firefox/browser/defaults/preferences/devtools.js",
        "/usr/share/firefox/browser/defaults/preferences/firefox-branding.js",
        "/usr/share/firefox/browser/defaults/preferences/vendor.js",
        "/usr/share/firefox/browser/defaults/preferences/firefox.js",
        "/etc/firefox/firefox.js",
        // Pref files can be found here:
        // https://developer.mozilla.org/en-US/docs/Mozilla/Preferences/A_brief_guide_to_Mozilla_preferences
        profile + "grepref.js",
        profile + "services/common/services-common.js",
        profile + "defaults/pref/services-sync.js",
        profile + "browser/app/profile/channel-prefs.js",
        profile + "browser/app/profile/firefox.js",
        profile + "browser/app/profile/firefox-branding.js",
        profile + "browser/defaults/preferences/firefox-l10n.js",
        profile + "prefs.js",
        profile + "user.js",
    ]
    const promises = []
    // Starting all promises before awaiting because we want the calls to be
    // made in parallel
    for (const file of prefFiles) {
        promises.push(loadPrefs(file))
    }
    cached_prefs = promises.reduce(async (a, b) =>
        Object.assign(await a, await b),
    )
    return cached_prefs
}

/** Returns the value for the corresponding about:config setting */
export async function getPref(name: string): Promise<string> {
    return (await getPrefs())[name]
}

/** Fetches a config option from the config. If the option is undefined, fetch
 *  a preference from preferences. It would make more sense for this function to
 *  be in config.ts but this would require importing this file in config.ts and
 *  Webpack doesn't like circular dependencies.
 */
export async function getConfElsePref(
    confName: string,
    prefName: string,
): Promise<any> {
    let option = await config.getAsyncDynamic(confName)
    if (option === undefined) {
        try {
            option = await getPref(prefName)
        } catch (e) {}
    }
    return option
}

/** Fetches a config option from the config. If the option is undefined, fetch
 *  prefName from the preferences. If prefName is undefined too, return a
 *  default.
 */
export async function getConfElsePrefElseDefault(
    confName: string,
    prefName: string,
    def: any,
): Promise<any> {
    const option = await getConfElsePref(confName, prefName)
    if (option === undefined) return def
    return option
}

/** Writes a preference to user.js */
export async function writePref(name: string, value: any) {
    if (cached_prefs) cached_prefs[name] = value

    const file = (await getProfileDir()) + "/user.js"
    // No need to check the return code because read returns "" when failing to
    // read a file
    const text = (await read(file)).content
    const prefPos = text.indexOf(`pref("${name}",`)
    if (prefPos < 0) {
        write(file, `${text}\nuser_pref("${name}", ${value});\n`)
    } else {
        let substr = text.substring(prefPos)
        const prefEnd = substr.indexOf(";\n")
        substr = text.substring(prefPos, prefPos + prefEnd)
        write(file, text.replace(substr, `pref("${name}", ${value})`))
    }
}
