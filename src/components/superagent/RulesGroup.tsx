// Settings › Superagent › 2. Choose what it may start: each rule is Off or Observe; Auto is shown but waits for the next phase.
import { native } from '../../lib/native';
import type { SuperagentConfig, SuperagentMode } from '../../lib/native/superagent';
import { Group, Row } from '../pages/settings/Controls';

const MODES: { value: SuperagentMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'observe', label: 'Observe' },
];

export function RulesGroup({ config, change }: { config: SuperagentConfig; change: (run: () => Promise<unknown>) => Promise<boolean> }) {
  return (
    <Group
      title="2. Choose what it may start"
      desc="Each rule decides once per thread every 5 minutes and up to 20 an hour; past that it asks a person."
    >
      {config.rules.map((rule) => (
        <Row key={rule.id} title={rule.name} desc={rule.available ? rule.line : `${rule.line} Not watched yet.`}>
          <div className="segmented" role="group" aria-label={`${rule.name} mode`}>
            {MODES.map((m) => (
              <button
                key={m.value}
                className={rule.available && m.value === rule.mode ? 'on' : ''}
                aria-pressed={rule.available && m.value === rule.mode}
                disabled={!rule.available}
                onClick={() => m.value !== rule.mode && void change(() => native.superagent.setRule(rule.id, m.value))}
              >
                {m.label}
              </button>
            ))}
            <button disabled title="Arrives with the next phase" aria-pressed={false}>
              Auto
            </button>
          </div>
        </Row>
      ))}
    </Group>
  );
}
