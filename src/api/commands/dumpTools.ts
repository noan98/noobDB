// `src-tauri/src/commands/dump_tools.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { DumpToolName, DumpToolStatus } from "../tauri";

export const dumpToolsCommands = {

  /** ダンプ用ツールがこの PC にあるか (無ければ導入方法も) を調べる。 */
  dumpToolStatus: (tool: DumpToolName) =>
    invoke<DumpToolStatus>("dump_tool_status", { tool }).then((r) =>
      parseResponse(schemas.dumpToolStatus, r, "dump_tool_status"),
    ),
  /** ダンプ用ツールを OS のパッケージマネージャでこの PC に導入する (winget / Homebrew)。 */
  installDumpTool: (tool: DumpToolName) =>
    invoke<DumpToolStatus>("install_dump_tool", { tool }).then((r) =>
      parseResponse(schemas.dumpToolStatus, r, "install_dump_tool"),
    ),
};
