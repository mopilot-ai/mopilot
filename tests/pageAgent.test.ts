// Page-agent UT entrypoint: case groups register in original order with one shared world.
import { registerOutlineCases } from './support/page-agent/outline';
import { registerAccessibilityCases } from './support/page-agent/accessibility';
import { registerGeometryCases } from './support/page-agent/geometry';
import { registerFormsStateCases } from './support/page-agent/forms-state';
import { registerLocatorsCases } from './support/page-agent/locators';
import { registerInspectionCases } from './support/page-agent/inspection';
import { registerSensitiveFieldsCases } from './support/page-agent/sensitive-fields';

registerOutlineCases();
registerAccessibilityCases();
registerGeometryCases();
registerFormsStateCases();
registerLocatorsCases();
registerInspectionCases();
registerSensitiveFieldsCases();
