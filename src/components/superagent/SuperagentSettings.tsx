// Settings › Superagent (S1, watch only): connect one repository and the people who may ask, choose what each rule may start (Off or Observe), read what it would have done and mark it Right or Wrong, pause.
// Behind the `superagent` flag (the section is not listed while it is off). Nothing here posts, runs or writes to GitHub.
import { useState } from 'react';
import { Group, Row } from '../pages/settings/Controls';
import { ConnectGroup } from './ConnectGroup';
import { ObserveLog } from './ObserveLog';
import { RulesGroup } from './RulesGroup';
import { pluralize } from '../../lib/format';
import { problemText } from './model';
import { useSuperagent } from './useSuperagent';
import { native } from '../../lib/native';
import type { SuperagentProblem } from '../../lib/native/superagent';

/** The one error shown when there is no database: what happened, and for damage, where the copy is kept and a confirmed way to start fresh. */
function Problem({ error, change }: { error: SuperagentProblem; change: (run: () => Promise<unknown>) => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  return (
    <Group>
      <Row
        title={asking ? 'Start a fresh database?' : 'Superagent stopped'}
        desc={asking ? 'What it recorded stays in the damaged copy. Events are read again from GitHub.' : problemText(error)}
      >
        {asking ? (
          <>
            <button className="btn-pill" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              className="btn-pill danger outline"
              onClick={async () => {
                // a refusal is told; either way the confirmation closes
                await change(() => native.superagent.acknowledge());
                setAsking(false);
              }}
            >
              Start fresh
            </button>
          </>
        ) : (
          error.code === 'damaged' && (
            <button className="btn-pill" onClick={() => setAsking(true)}>
              Start fresh…
            </button>
          )
        )}
      </Row>
    </Group>
  );
}

export default function SuperagentSettings() {
  const { state, failure, change } = useSuperagent();
  if (failure)
    return (
      <Group>
        <Row title="Superagent" desc={failure} />
      </Group>
    );
  if (!state) return null;
  if (!state.ok) return <Problem error={state.error} change={change} />;
  return (
    <>
      {state.reconcile.length > 0 && (
        <Group>
          <Row
            title="Interrupted"
            desc={`${pluralize(state.reconcile.length, 'event')} may have run before a restart and need checking.`}
          />
        </Group>
      )}
      <ConnectGroup config={state.config} source={state.source} change={change} />
      <RulesGroup config={state.config} change={change} />
      <ObserveLog log={state.log} stats={state.stats} change={change} />
    </>
  );
}
