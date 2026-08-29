import { join } from 'node:path'
import * as os from 'node:os'
import * as vscode from 'vscode'
import { DeepSeekHarnessAdapter } from '../harness/DeepSeekHarnessAdapter.ts'
import type { HarnessAdapter, RuntimeStatus } from '../harness/HarnessAdapter.ts'

export class HarnessRuntimeManager implements vscode.Disposable {
  private adapterInstance: HarnessAdapter | undefined; private startTask: Promise<HarnessAdapter> | undefined
  private generation = 0
  private status: RuntimeStatus = { state: 'stopped' }
  private readonly emitter = new vscode.EventEmitter<RuntimeStatus>(); readonly onDidChangeStatus = this.emitter.event
  private readonly output = vscode.window.createOutputChannel('DeepSeek Harness Runtime')
  constructor(private readonly context: vscode.ExtensionContext, private readonly workspaceRoot: string) {}
  get adapter(): HarnessAdapter | undefined { return this.adapterInstance }
  getStatus(): RuntimeStatus { return this.status }
  start(): Promise<HarnessAdapter> {
    if (this.adapterInstance?.getStatus().state === 'ready') return Promise.resolve(this.adapterInstance)
    if (this.startTask !== undefined) return this.startTask
    const generation = ++this.generation
    const task = this.performStart(generation)
    this.startTask = task
    void task.finally(() => { if (this.startTask === task) this.startTask = undefined }).catch(() => undefined)
    return task
  }
  async stop(): Promise<void> {
    ++this.generation
    const starting = this.startTask; this.startTask = undefined
    const adapter = this.adapterInstance ?? await starting?.catch(() => undefined)
    if (this.adapterInstance === adapter) this.adapterInstance = undefined
    await adapter?.stop(); this.publish({ state: 'stopped' })
  }
  async restart(): Promise<HarnessAdapter> { await this.stop(); return this.start() }
  dispose(): void { void this.stop(); this.output.dispose(); this.emitter.dispose() }
  private publish(status: RuntimeStatus): void { this.status = status; this.emitter.fire(status) }
  private async performStart(generation: number): Promise<HarnessAdapter> {
    this.publish({ state: 'starting' }); const config = vscode.workspace.getConfiguration('deepseekHarness')
    const dataDir = this.resolveDataDir(config); await vscode.workspace.fs.createDirectory(vscode.Uri.file(dataDir))
    const command = this.resolveCommand(config); const args = this.resolveArgs(config)
    this.output.appendLine(`[runtime] command=${command} args=${JSON.stringify(args)} cwd=${this.workspaceRoot} dataDir=${dataDir}`)
    const adapter = new DeepSeekHarnessAdapter({ command, args, cwd: this.workspaceRoot,
      env: this.resolveEnv(config, dataDir), provider: config.get('provider', 'deepseek-official'), model: config.get('model', 'deepseek-v4-flash'),
      onStderr: line => this.output.appendLine(`[runtime stderr] ${line}`), onStatus: status => { if (generation === this.generation) this.publish(status) } })
    try {
      await adapter.start()
      if (generation !== this.generation) { await adapter.stop(); throw new Error('Runtime start was superseded') }
      this.adapterInstance = adapter; this.publish(adapter.getStatus()); return adapter
    } catch (error) {
      if (generation === this.generation) this.publish({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  // The bundled runtime binary ships alongside the extension and is the
  // zero-configuration default. A user-configured command still wins so power
  // users can point at their own dsh-py (e.g. a source checkout).
  private resolveCommand(config: vscode.WorkspaceConfiguration): string {
    const configured = config.get<string>('runtime.command')
    if (configured !== undefined && configured.trim() !== '') return configured
    const binary = process.platform === 'win32' ? 'dsh-py.exe' : 'dsh-py'
    // The bundled PyInstaller runtime is an onedir build. Unlike a one-file
    // executable it does not unpack ~30 MB into a temporary directory at every
    // cold start, which significantly reduces sidebar-open latency on macOS.
    return join(this.context.extensionUri.fsPath, 'bin', 'dsh-py', binary)
  }

  // The runtime reuses the same DeepSeek Harness home directory as the web
  // harness (~/.dsh by default), so API keys configured in the web UI are
  // picked up automatically via the shared .credentials.yaml file. A
  // user-configured dataDir (or the DSH_DATA_DIR env var) still wins.
  private resolveDataDir(config: vscode.WorkspaceConfiguration): string {
    const configured = config.get<string>('dataDir')
    if (configured !== undefined && configured.trim() !== '') return configured
    if (process.env.DSH_DATA_DIR !== undefined && process.env.DSH_DATA_DIR.trim() !== '') return process.env.DSH_DATA_DIR
    return join(os.homedir(), '.dsh')
  }

  private resolveArgs(config: vscode.WorkspaceConfiguration): string[] {
    return config.get<string[]>('runtime.arguments', ['sdk'])
  }

  // Build the child env. We reuse the web harness's home directory (dataDir)
  // and its zstd session compression so credentials and session history are
  // shared across the web UI and the extension. An explicitly configured
  // sessionCompression (or DSH_SESSION_COMPRESSION) still wins.
  private resolveEnv(config: vscode.WorkspaceConfiguration, dataDir: string): NodeJS.ProcessEnv {
    const compression = config.get<string>('sessionCompression', 'zstd')
    const usingBundledRuntime = (config.get<string>('runtime.command') ?? '').trim() === ''
    // PyInstaller does not have the macOS framework Python's default CA path.
    // Use the certifi bundle shipped with our onedir runtime so httpx/ssl never
    // inherits a stale SSL_CERT_FILE from VS Code or the user's shell.
    const bundledCaFile = join(this.context.extensionUri.fsPath, 'bin', 'dsh-py', 'runtime', 'certifi', 'cacert.pem')
    return {
      ...process.env,
      DSH_CWD: this.workspaceRoot,
      DSH_DATA_DIR: dataDir,
      DSH_SESSION_COMPRESSION: compression !== undefined && compression.trim() !== '' ? compression : 'zstd',
      ...(config.get<string>('endpoint', '').trim() === '' ? {} : { DEEPSEEK_BASE_URL: config.get<string>('endpoint', '').trim() }),
      DSH_PERMISSION_MODE: config.get<string>('permissionMode', 'workspace-write'),
      ...(usingBundledRuntime ? { SSL_CERT_FILE: bundledCaFile, REQUESTS_CA_BUNDLE: bundledCaFile } : {}),
    }
  }
}
