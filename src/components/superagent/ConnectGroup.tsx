// Settings › Superagent › 1. Connect: the one repository, the people who may ask, and the pauses (everything, or GitHub alone).
import { native } from '../../lib/native';
import type { SuperagentConfig, SuperagentSource } from '../../lib/native/superagent';
import { Group, Row, Toggle } from '../pages/settings/Controls';
import { SaveField } from './SaveField';
import { loginsFrom, sourceText } from './model';

export function ConnectGroup({
  config,
  source,
  change,
}: {
  config: SuperagentConfig;
  source: SuperagentSource;
  change: (run: () => Promise<unknown>) => Promise<boolean>;
}) {
  return (
    <Group
      title="1. Connect"
      desc={`Watches GitHub and notes what it would do. Nothing is posted or run. A mention of @${config.botLogin} is an explicit request.`}
    >
      <Row title="Pause everything" desc="Nothing is decided while paused. Events are still saved.">
        <Toggle on={config.paused.all} label="Pause everything" onChange={(on) => change(() => native.superagent.setPaused('all', on))} />
      </Row>
      <Row title="Repository" desc={sourceText(source)}>
        <SaveField
          label="Repository"
          placeholder="owner/name"
          value={config.repo ?? ''}
          onSave={(text) => change(() => native.superagent.setRepo(text.trim() === '' ? null : text))}
        />
      </Row>
      <Row title="Pause GitHub" desc="Stops this source alone.">
        <Toggle on={config.paused.github} label="Pause GitHub" onChange={(on) => change(() => native.superagent.setPaused('github', on))} />
      </Row>
      <Row title="Allowed people" desc="Only these GitHub logins can start work. Bots never can.">
        <SaveField
          label="Allowed people"
          placeholder="alice, bob"
          value={config.allowed.join(', ')}
          onSave={(text) => change(() => native.superagent.setAllowed(loginsFrom(text)))}
        />
      </Row>
    </Group>
  );
}
