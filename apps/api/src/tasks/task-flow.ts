/**
 * The task state machine, in one place. Drivers move a task forward from the app
 * (see driver.controller DRIVER_FLOW); staff publish, assign, cancel, review and reopen.
 */
export const TASK_STATUSES = ['draft', 'ready', 'assigned', 'accepted', 'in_progress', 'completed', 'reviewed', 'invoiced', 'failed', 'canceled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type StaffAction = 'publish' | 'assign' | 'unassign' | 'cancel' | 'review' | 'reopen';

/** From which statuses each staff action is allowed, and the status it leads to. */
export const STAFF_FLOW: Record<StaffAction, { from: TaskStatus[]; to: TaskStatus }> = {
  publish: { from: ['draft'], to: 'ready' },
  assign: { from: ['ready', 'assigned', 'accepted'], to: 'assigned' }, // from assigned/accepted = reassign
  unassign: { from: ['assigned', 'accepted'], to: 'ready' },
  cancel: { from: ['draft', 'ready', 'assigned', 'accepted', 'in_progress', 'failed'], to: 'canceled' },
  review: { from: ['completed'], to: 'reviewed' },
  reopen: { from: ['failed'], to: 'ready' },
};

/** Editable fields can change only before the driver starts. */
export const EDITABLE: TaskStatus[] = ['draft', 'ready', 'assigned', 'accepted'];
/** Statuses that keep the driver's assignment alive. */
export const HOLDS_ASSIGNMENT: TaskStatus[] = ['assigned', 'accepted', 'in_progress', 'completed', 'failed', 'reviewed', 'invoiced'];

export function canStaff(action: StaffAction, from: string): boolean {
  return (STAFF_FLOW[action].from as string[]).includes(from);
}
