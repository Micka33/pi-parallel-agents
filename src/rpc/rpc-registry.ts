export interface RegisteredRpcProcess {
  agentId: string;
  pid: number;
  cwd: string;
}

const registry = new Map<string, RegisteredRpcProcess>();

export function registerRpcProcess(process: RegisteredRpcProcess): void {
  registry.set(process.agentId, process);
}

export function getRpcProcess(agentId: string): RegisteredRpcProcess | undefined {
  return registry.get(agentId);
}

export function unregisterRpcProcess(agentId: string): void {
  registry.delete(agentId);
}

export function listRpcProcesses(): RegisteredRpcProcess[] {
  return [...registry.values()];
}
