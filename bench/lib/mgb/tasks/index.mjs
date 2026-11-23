// MoPilot 12-Grid Bench (#1381) task catalog: every MGB task, in the order a run takes them.
import { task as dealReview } from './f1DealReview.mjs';
import { task as escalations } from './f1Escalations.mjs';
import { task as invoiceReconcile } from './f1InvoiceReconcile.mjs';
import { task as refundRequests } from './f1RefundRequests.mjs';
import { task as restockOrders } from './f1RestockOrders.mjs';
import { task as weeklyReport } from './f1WeeklyReport.mjs';
import { task as expenseReport } from './f2ExpenseReport.mjs';
import { task as onboarding } from './f2Onboarding.mjs';
import { task as quoteForms } from './f2QuoteForms.mjs';
import { task as supplierForms } from './f2SupplierForms.mjs';
import { task as accountSecurity } from './f3AccountSecurity.mjs';
import { task as apiKeys } from './f3ApiKeys.mjs';
import { task as sessionAudit } from './f3SessionAudit.mjs';
import { task as reminderTriage } from './f4ReminderTriage.mjs';
import { task as tripPlan } from './f4TripPlan.mjs';
import { task as weekPlan } from './f4WeekPlan.mjs';
import { task as conferencePlan } from './f5ConferencePlan.mjs';
import { task as hiringResearch } from './f5HiringResearch.mjs';
import { task as vendorShortlist } from './f5VendorShortlist.mjs';
import { task as crossSurfaceSwitch } from './f6CrossSurfaceSwitch.mjs';
import { task as refundHandoff } from './f6RefundHandoff.mjs';
import { task as trackerMigration } from './f6TrackerMigration.mjs';
import { task as crashRecovery } from './f7CrashRecovery.mjs';
import { task as docInjection } from './f7DocInjection.mjs';
import { task as escStop } from './f7EscStop.mjs';
import { task as mailInjection } from './f7MailInjection.mjs';
import { task as payAndDelete } from './f7PayAndDelete.mjs';
import { task as readonlyRaise } from './f7ReadonlyRaise.mjs';
import { task as taintAllowDeny } from './f7TaintAllowDeny.mjs';
import { task as vendorInjection } from './f7VendorInjection.mjs';
import { task as researchHandoff } from './f8ResearchHandoff.mjs';
import { task as usageLimit } from './f8UsageLimit.mjs';
import { task as warehouseDesk } from './f8WarehouseDesk.mjs';

/** @type {import('../schema.mjs').Task[]} */
export const CATALOG = [
  invoiceReconcile,
  refundRequests,
  dealReview,
  restockOrders,
  escalations,
  weeklyReport,
  onboarding,
  supplierForms,
  quoteForms,
  expenseReport,
  accountSecurity,
  sessionAudit,
  apiKeys,
  weekPlan,
  tripPlan,
  reminderTriage,
  vendorShortlist,
  conferencePlan,
  hiringResearch,
  refundHandoff,
  trackerMigration,
  crossSurfaceSwitch,
  mailInjection,
  docInjection,
  vendorInjection,
  payAndDelete,
  taintAllowDeny,
  crashRecovery,
  escStop,
  readonlyRaise,
  researchHandoff,
  warehouseDesk,
  usageLimit,
];
