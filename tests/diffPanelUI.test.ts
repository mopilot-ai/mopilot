// Diff-panel UI unit cases registered in their original order with one shared fixture.
import { registerScopes } from './support/diff-panel-ui/scopes.ts';
import { registerNavigation, registerCollapse } from './support/diff-panel-ui/navigation.ts';
import { registerFindings } from './support/diff-panel-ui/findings.ts';
import { registerActions } from './support/diff-panel-ui/actions.ts';
import { registerPatches } from './support/diff-panel-ui/patches.ts';
import { registerMutations } from './support/diff-panel-ui/mutations.ts';
import { registerRepositories } from './support/diff-panel-ui/repositories.ts';
import { registerContext } from './support/diff-panel-ui/context.ts';
import { registerComments } from './support/diff-panel-ui/comments.ts';

registerScopes();
registerNavigation();
registerFindings();
registerActions();
registerPatches();
registerMutations();
registerRepositories();
registerCollapse();
registerContext();
registerComments();
