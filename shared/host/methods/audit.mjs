// The audit record's wire method (host/src/audit.mjs): the app's own "Activity on this machine" view reads it; an older Host has none, so an app without the feature is refused, never served half.
import { AUDIT_FEATURE, AUDIT_READ_METHOD, auditParsers } from '../audit.mjs';

/** @param {{ bad: (message: string) => Error }} kit */
export default ({ bad }) => ({
  features: [AUDIT_FEATURE],
  methods: { [AUDIT_READ_METHOD]: { access: 'paired', requires: [AUDIT_FEATURE], parse: auditParsers(bad)[AUDIT_READ_METHOD] } },
});
