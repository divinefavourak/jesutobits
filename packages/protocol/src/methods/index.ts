import type { z } from "zod";
import {
  agentAnswerQuestion,
  agentCancelTurn,
  agentPauseTurn,
  agentResumeTurn,
  agentRetryTurn,
  agentSendMessage,
  agentSetModel,
  checkpointsListForTurn,
  checkpointsRevertFile,
  checkpointsRevertTurn,
  modelsList,
  modelsTestConnection,
  permissionsGetPolicy,
  permissionsListRules,
  permissionsRemoveRule,
  permissionsRespond,
  permissionsSetPolicy,
  sessionsArchive,
  sessionsCreate,
  sessionsDelete,
  sessionsGet,
  sessionsHistory,
  sessionsList,
  sessionsRename,
} from "./agent.js";
import type { Caller, MethodDefinition } from "./define.js";
import { eventsReplay } from "./events.js";
import {
  fsCreateDirectory,
  fsCreateFile,
  fsListDir,
  fsQuickOpen,
  fsReadFile,
  fsRename,
  fsReveal,
  fsSearch,
  fsStat,
  fsTrash,
  fsWriteFile,
} from "./fs.js";
import {
  projectsClose,
  projectsCreate,
  projectsDetect,
  projectsList,
  projectsLocate,
  projectsOpen,
  projectsPrepareWorkspaceFolder,
  projectsRemove,
  projectsSetTrust,
} from "./projects.js";
import { toolchainDetect } from "./toolchain.js";
import { runtimeConfigure, runtimeInitialize, runtimePing, runtimeShutdown } from "./runtime.js";

export { defineMethod } from "./define.js";
export { eventsReplay } from "./events.js";
export * from "./agent.js";
export * from "./fs.js";
export * from "./projects.js";
export * from "./toolchain.js";
export type { Caller, MethodDefinition } from "./define.js";
export { runtimeConfigure, runtimeInitialize, runtimePing, runtimeShutdown } from "./runtime.js";

/** Every runtime method. Adding one here is step one of ADR-0003's "two changes" rule. */
export const METHODS = {
  [runtimeInitialize.name]: runtimeInitialize,
  [runtimePing.name]: runtimePing,
  [runtimeShutdown.name]: runtimeShutdown,
  [runtimeConfigure.name]: runtimeConfigure,
  [eventsReplay.name]: eventsReplay,
  [projectsList.name]: projectsList,
  [projectsOpen.name]: projectsOpen,
  [projectsCreate.name]: projectsCreate,
  [projectsClose.name]: projectsClose,
  [projectsSetTrust.name]: projectsSetTrust,
  [projectsRemove.name]: projectsRemove,
  [projectsLocate.name]: projectsLocate,
  [projectsDetect.name]: projectsDetect,
  [projectsPrepareWorkspaceFolder.name]: projectsPrepareWorkspaceFolder,
  [toolchainDetect.name]: toolchainDetect,
  [fsListDir.name]: fsListDir,
  [fsStat.name]: fsStat,
  [fsReadFile.name]: fsReadFile,
  [fsWriteFile.name]: fsWriteFile,
  [fsCreateFile.name]: fsCreateFile,
  [fsCreateDirectory.name]: fsCreateDirectory,
  [fsRename.name]: fsRename,
  [fsQuickOpen.name]: fsQuickOpen,
  [fsSearch.name]: fsSearch,
  [fsTrash.name]: fsTrash,
  [fsReveal.name]: fsReveal,
  [sessionsList.name]: sessionsList,
  [sessionsCreate.name]: sessionsCreate,
  [sessionsGet.name]: sessionsGet,
  [sessionsHistory.name]: sessionsHistory,
  [sessionsRename.name]: sessionsRename,
  [sessionsArchive.name]: sessionsArchive,
  [sessionsDelete.name]: sessionsDelete,
  [agentSendMessage.name]: agentSendMessage,
  [agentCancelTurn.name]: agentCancelTurn,
  [agentPauseTurn.name]: agentPauseTurn,
  [agentResumeTurn.name]: agentResumeTurn,
  [agentRetryTurn.name]: agentRetryTurn,
  [agentAnswerQuestion.name]: agentAnswerQuestion,
  [agentSetModel.name]: agentSetModel,
  [permissionsRespond.name]: permissionsRespond,
  [permissionsListRules.name]: permissionsListRules,
  [permissionsRemoveRule.name]: permissionsRemoveRule,
  [permissionsGetPolicy.name]: permissionsGetPolicy,
  [permissionsSetPolicy.name]: permissionsSetPolicy,
  [checkpointsListForTurn.name]: checkpointsListForTurn,
  [checkpointsRevertTurn.name]: checkpointsRevertTurn,
  [checkpointsRevertFile.name]: checkpointsRevertFile,
  [modelsList.name]: modelsList,
  [modelsTestConnection.name]: modelsTestConnection,
} as const;

export type MethodName = keyof typeof METHODS;
export type MethodParams<M extends MethodName> = z.input<(typeof METHODS)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.output<(typeof METHODS)[M]["result"]>;

/** Methods the Workbench may call through the Host relay. */
export type WorkbenchMethod = {
  [M in MethodName]: "workbench" extends (typeof METHODS)[M]["callers"][number] ? M : never;
}[MethodName];

export function getMethod(name: string): MethodDefinition | undefined {
  return Object.hasOwn(METHODS, name) ? METHODS[name as MethodName] : undefined;
}

export function methodsCallableBy(caller: Caller): MethodName[] {
  return (Object.keys(METHODS) as MethodName[])
    .filter((name) => (METHODS[name].callers as readonly Caller[]).includes(caller))
    .sort();
}
