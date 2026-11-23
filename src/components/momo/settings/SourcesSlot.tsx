// Where Settings › MoMo › Sources and setup's Connect sources step mount MoMo's sources section (#2181): Calendar, Reminders and Files, on window.native.momoSources, then the cloud accounts (#2999) on window.native.momoConnectors and the coding-side MCP servers on window.native.momoMcp.
import { CodingToolsSection } from '../CodingToolsSection';
import { ConnectorsSection } from '../ConnectorsSection';
import { SourcesSection } from '../SourcesSection';

export function MomoSourcesSlot() {
  return (
    <>
      <SourcesSection />
      <ConnectorsSection />
      <CodingToolsSection />
    </>
  );
}
