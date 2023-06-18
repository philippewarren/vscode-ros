// Copyright (c) Andrew Short. All rights reserved.
// Licensed under the MIT License.

import * as child_process from "child_process";
import * as os from "os";
import * as shell_quote from "shell-quote";
import * as util from "util";
import * as vscode from "vscode";
import { setTimeout as sleep } from 'node:timers/promises';

import * as requests from "../../requests";
import { rosApi } from "../../../ros/ros";


export const promisifiedExec = util.promisify(child_process.exec);

export interface ILaunchRequest {
    nodeName: string;
    executable: string;
    arguments: string[];
    cwd: string;
    env: { [key: string]: string };
    symbolSearchPath?: string;
    additionalSOLibSearchPath?: string;
    sourceFileMap?: { [key: string]: string };
    launch?: string[];                      // Scripts or executables to just launch without attaching a debugger
    attachDebugger?: string[];              // If specified, scripts, executables or nodes to debug; otherwise attaches to everything not ignored
    stopAll?: boolean;                      // If true, stop all nodes when the debugger is stopped
    stopCoreAfterDebug?: boolean;           // If true, stop the roscore when the last debugger node is stopped
    stopLaunchedNodes?: boolean;            // If true, stop the launched nodes when the last debugged node is stopped
    attachTerminalsToProcesses?: boolean;   // If true, create terminals to display the output of the launched nodes
    terminateOnTerminalClosed?: boolean;    // If true, terminate the launched nodes when the terminal is closed
}

export class RosLaunchDebugConfigurationProvider {
    private processesToLaunch: Array<{ nodeName: string, command: string; rosSpawnOptions: child_process.SpawnOptions; }> = [];
    private launchGroupHandler: LaunchGroupHandler = new LaunchGroupHandler();

    public sessionStarted(session: vscode.DebugSession) {
        this.launchGroupHandler.sessionStarted(session);
    }

    public async sessionStopped(stopped_session: vscode.DebugSession) {
        await this.launchGroupHandler.sessionStopped(stopped_session);
    }

    public addProcess(nodeName: string, command: string, rosSpawnOptions: child_process.SpawnOptions) {
        this.processesToLaunch.push({ nodeName: nodeName, command: command, rosSpawnOptions: rosSpawnOptions });
    }

    public startProcesses() {
        this.processesToLaunch.forEach((processToLaunch) => {
            this.launchGroupHandler.executeSpawnProcess(processToLaunch.nodeName, processToLaunch.command, processToLaunch.rosSpawnOptions);
        });
        this.clearProcesses();
    }

    public clearProcesses() {
        this.processesToLaunch = [];
    }

    public async registerLaunchRequest(launchRequest: requests.ILaunchRequest) {
        this.launchGroupHandler.configure(launchRequest);
        await this.launchGroupHandler.clearTerminals();
    }
}

export class LaunchGroupHandler {
    private sessions: Array<vscode.DebugSession> = [];
    private processes: Array<child_process.ChildProcess> = [];
    private terminals: Array<vscode.Terminal> = [];
    private stopping: boolean = false;
    private processesErrorListeners: { [command: string]: (error: string) => void } = {};
    private stopAll: boolean = false;
    private stopCoreAfterDebug: boolean = false;
    private stopLaunchedNodes: boolean = true;
    private attachTerminalsToProcesses: boolean = true;
    private terminateOnTerminalClosed: boolean = true;

    private processErrorListener(command: string): (error: string) => void {
        if (this.processesErrorListeners[command] === undefined) {
            this.processesErrorListeners[command] = (error: string) => {
                throw (new Error(`Error from ${command}:\n ${error}`));
            };
        }
        return this.processesErrorListeners[command];
    }

    private async stopAllProcesses() {
        if (this.stopLaunchedNodes !== false)
            await Promise.all(this.processes.map(async (p) => {
                await this.killProcess(p);
            }));
        if (await rosApi.getCoreStatus() === true && this.stopCoreAfterDebug === true) {
            rosApi.stopCore();
        }
        this.processes = [];
    }

    public async clearTerminals() {
        await Promise.all(this.terminals.map(async (terminal) => {
            terminal.dispose();
        }));
        this.terminals = [];
    }

    public sessionStarted(session: vscode.DebugSession) {
        this.sessions.push(session);
    }

    public async sessionStopped(stopped_session: vscode.DebugSession) {

        if (this.stopAll === true) {
            if (this.stopping === true) { // Don't recursively stop
                return;
            }

            this.stopping = true;

            await Promise.all(this.sessions.map(async (session) => {
                if (session.id !== stopped_session.id) { // Don't stop the session that just stopped
                    await vscode.debug.stopDebugging(session);
                }
            }));
            await this.stopAllProcesses();

            this.sessions = [];
            this.stopping = false;

        } else {
            this.sessions = this.sessions.filter((session) => session.id !== stopped_session.id);

            if (this.sessions.length === 0) {
                await this.stopAllProcesses();
            }
        }
    }

    public processStarted(process: child_process.ChildProcess) {
        this.processes.push(process);
    }

    public configure(config: requests.ILaunchRequest) {
        this.stopAll = config.stopAll;
        this.stopCoreAfterDebug = config.stopCoreAfterDebug;
        this.stopLaunchedNodes = config.stopLaunchedNodes;
        this.attachTerminalsToProcesses = config.attachTerminalsToProcesses;
        this.terminateOnTerminalClosed = config.terminateOnTerminalClosed;
    }

    private async killProcess(p: child_process.ChildProcess) {
        const command = p.spawnargs.join(" ");
        p.removeListener("error", this.processErrorListener(command));

        p.kill("SIGINT");
        await sleep(5000);
        try {
            if (!p.kill(0)) { // Unclear how this fails, via exception or return value
                return;
            }
        } catch {
            return;
        }

        // Escalate to SIGTERM
        p.kill("SIGTERM");
        await sleep(2000);
        try {
            if (!p.kill(0)) { // Unclear how this fails, via exception or return value
                return;
            }
        } catch {
            return;
        }

        // Escalate to SIGKILL
        p.kill("SIGKILL");
    }

    public executeSpawnProcess(nodeName: string, command: string, rosSpawnOptions: child_process.SpawnOptions) {
        const { executable, args, envConfig } = parseCommand(command);

        if (this.attachTerminalsToProcesses !== false) {
            // We want the output unbuffered, so we can display it in the terminal as it comes in
            rosSpawnOptions.env["PYTHONUNBUFFERED"] = "1";
            rosSpawnOptions.env["ROSCONSOLE_STDOUT_LINE_BUFFERED"] = "1";
        }

        const child = child_process.spawn(executable, args, rosSpawnOptions);

        child.on('error', this.processErrorListener(command));

        if (this.attachTerminalsToProcesses !== false) {

            var on_close: () => void;
            if (this.terminateOnTerminalClosed !== false) {
                on_close = () => {
                    this.processes = this.processes.filter((p) => p.pid !== child.pid);
                    this.killProcess(child);
                };
            }
            else {
                on_close = () => { };
            }

            const writeEmitter = new vscode.EventEmitter<string>();
            const terminal = vscode.window.createTerminal({
                name: nodeName,
                pty: {
                    onDidWrite: writeEmitter.event,
                    close: on_close,
                    open: () => { },
                }
            });

            // rospy (via rosgraph/roslogging.py) does not add color if the output is not a tty, so we add it back here
            const printToTerminal = (data: string) => {
                const loggingLevelToColor = {
                    'DEBUG': '\x1b[32m',
                    'INFO': null,
                    'WARN': '\x1b[33m',
                    'ERROR': '\x1b[31m',
                    'FATAL': '\x1b[31m',
                }
                const colorReset = '\x1b[0m'

                const line = data.replace('\n', '');

                for (const [level, color] of Object.entries(loggingLevelToColor)) {
                    if (line.indexOf(`[${level}]`) !== -1) {
                        if (color !== null && line.indexOf(color) === -1) {
                            writeEmitter.fire(`${color}${line}${colorReset}\r\n`);
                            return;
                        }
                    }
                }
                writeEmitter.fire(`${line}\r\n`);
            }

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', printToTerminal);
            child.stderr.on('data', printToTerminal);

            this.terminals.push(terminal);
        }

        this.processes.push(child);
    }
}

export function parseCommand(command: string): { executable: string, args: string[], envConfig: { [key: string]: string; } } {
    let parsedArgs: shell_quote.ParseEntry[];
    const isWindows = os.platform() === "win32";

    if (isWindows) {
        // https://github.com/ros/ros_comm/pull/1809
        // escape backslash in file path
        parsedArgs = shell_quote.parse(command.replace(/[\\]/g, "\\$&"));
        parsedArgs = shell_quote.parse(parsedArgs[2].toString().replace(/[\\]/g, "\\$&"));
    } else {
        parsedArgs = shell_quote.parse(command);
    }

    const envConfig: { [key: string]: string; } = {};
    while (parsedArgs) {
        // https://github.com/ros/ros_comm/pull/1809
        if (isWindows && parsedArgs[0].toString() === "set") {
            parsedArgs.shift();
        }
        if (parsedArgs[0].toString().includes("=")) {
            const arg = parsedArgs.shift().toString();
            envConfig[arg.substring(0, arg.indexOf("="))] = arg.substring(arg.indexOf("=") + 1);

            // https://github.com/ros/ros_comm/pull/1809
            // "&&" is treated as Object
            if (isWindows && parsedArgs[0] instanceof Object) {
                parsedArgs.shift();
            }
        } else {
            break;
        }
    }

    let executable = parsedArgs.shift().toString();

    return {
        executable: executable, args: parsedArgs.map((arg) => {
            return arg.toString();
        }), envConfig: envConfig,
    };
}


export function executableOrNodeMatchWhitelist(whitelist: string[], executableName: string, nodeName: string): boolean {

    // If the executable name is in the list, it matches.
    // Format: 'executableName'
    if (whitelist.indexOf(executableName) != -1) { return true; }

    // If the exact node name with the namespace is in the list, it matches.
    // Format: '/**/nodeName'
    if (whitelist.indexOf(nodeName) != -1) { return true; }

    const parts = nodeName.split("/");

    // If the exact node name without the namespace is in the list,  it matches.
    // Format: '/nodeName'
    if (whitelist.indexOf("/" + parts[parts.length - 1]) != -1) { return true; }

    // If the node namespace is at least partially in the list,  it matches.
    // Format: '/**/namespace/'
    for (let i = 1; i < parts.length; i++) {
        const namespace = parts.slice(0, i).join("/") + "/";
        if (whitelist.indexOf(namespace) != -1) { return true; }
    }

    // If the node name has a starting slash, or doesn't have at least a namespace part and a node name, it doesn't match, and will crash the next loop, so return now. 
    // Formats: 'name' or '/**'
    if (parts[0] === "/" || parts.length < 2) { return false; }

    // If the last parts of the namespace and the node names are in the list,  it matches.
    // Format: 'namespace/**/nodeName'
    for (let i = parts.length - 2; i > 0; i--) {
        const namespace = parts.slice(i, parts.length).join("/");
        if (whitelist.indexOf(namespace) != -1) { return true; }
    }

    // This one is not in the list, it doesn't match.
    return false;
}
