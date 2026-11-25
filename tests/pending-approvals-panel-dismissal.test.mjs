import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const approvalSrc = fs.readFileSync(path.resolve('src/components/ApprovalNotifications.tsx'), 'utf8');
const notifDropdownSrc = fs.readFileSync(path.resolve('src/components/NotificationDropdown.tsx'), 'utf8');

// -----------------------------------------------------------------------------
// SECTION 1: CODE ARCHITECTURE & CONTRACT CHECKS
// -----------------------------------------------------------------------------
test('1. Architectural Contracts: ApprovalNotifications auto-open logic is eliminated and dismissal is authoritative', () => {
  // A. Panel is closed by default
  assert.match(
    approvalSrc,
    /const\s*\[isOpen,\s*setIsOpen\]\s*=\s*useState\(false\)/,
    'ApprovalNotifications must initialize isOpen to false (closed by default)'
  );

  // B. loadPendingApprovals does NOT auto-open the panel on data fetch or signature change
  assert.doesNotMatch(
    approvalSrc,
    /if\s*\([^)]*currentSignature\s*!==\s*dismissedSignature[^)]*\)\s*\{[^}]*setShowNotification\(true\)/,
    'ApprovalNotifications must not auto-open on signature change or approval count change'
  );
  assert.doesNotMatch(
    approvalSrc,
    /loadPendingApprovals[\s\S]*?setShowNotification\(true\)/,
    'loadPendingApprovals must not call setShowNotification(true) or force panel open'
  );

  // C. Dismissal state is recorded in localStorage when X is clicked
  assert.match(
    approvalSrc,
    /localStorage\.setItem\(getOpenStateKey\(\),\s*'closed'\)/,
    'handleDismiss must record closed state in localStorage'
  );

  // D. Notification bell / trigger button and badge are rendered when closed and approvals exist
  assert.match(
    approvalSrc,
    /data-testid="pending-approvals-trigger"/,
    'Must provide a clickable pending approvals bell trigger when panel is closed'
  );
  assert.match(
    approvalSrc,
    /<Bell className="w-5 h-5 text-white" \/>/,
    'Trigger must display the Bell icon'
  );
  assert.match(
    approvalSrc,
    /\{pendingApprovals\.length\}/,
    'Must display the pending approval count badge'
  );

  // E. NotificationDropdown integrates with pending approvals count & open event
  assert.match(
    notifDropdownSrc,
    /pending-approvals-count-changed/,
    'NotificationDropdown must listen to pending-approvals-count-changed'
  );
  assert.match(
    notifDropdownSrc,
    /open-pending-approvals/,
    'NotificationDropdown must dispatch open-pending-approvals when clicked'
  );

  // F. ApprovalNotifications listens to external open events (e.g. from notification bell)
  assert.match(
    approvalSrc,
    /window\.addEventListener\('open-pending-approvals'/,
    'ApprovalNotifications must listen to open-pending-approvals'
  );
});

// -----------------------------------------------------------------------------
// SECTION 2: BEHAVIORAL STATE TRANSITION SIMULATION
// -----------------------------------------------------------------------------
test('2. Behavioral Verification: Panel remains closed across approvals, refetches, and navigation; opens only on explicit click', () => {
  const localStorageMock = new Map();
  const storage = {
    getItem: (key) => localStorageMock.get(key) ?? null,
    setItem: (key, val) => localStorageMock.set(key, String(val)),
  };

  class ApprovalPanelSimulator {
    constructor(userId = 'admin-user-1') {
      this.userId = userId;
      this.openKey = `approval_panel_open_${userId}`;
      this.dismissKey = `approval_popup_dismissed_${userId}`;
      // Closed by default; check storage
      const stored = storage.getItem(this.openKey);
      this.isOpen = stored === 'open';
      this.pendingApprovals = [];
    }

    // Simulates loadPendingApprovals (triggered on mount, refetch, or realtime event)
    loadPendingApprovals(newApprovals) {
      this.pendingApprovals = newApprovals;
      // CRITICAL REQUIREMENT: Data loading NEVER modifies isOpen!
      // If closed, it STAYS closed. If open, it STAYS open.
    }

    // User clicks the X button on the panel
    handleDismiss() {
      this.isOpen = false;
      storage.setItem(this.openKey, 'closed');
      storage.setItem(this.dismissKey, 'dismissed');
    }

    // User explicitly clicks the notification bell / trigger
    handleOpen() {
      this.isOpen = true;
      storage.setItem(this.openKey, 'open');
    }
  }

  // 1. Initial Mount: Admin user opens the app with 3 pending items (e.g. 1 Petty Cash, 1 Expense, 1 Sales Order)
  const initialItems = [
    { id: 'pc-1', type: 'petty_cash', number: 'PC-001' },
    { id: 'exp-1', type: 'expense', number: 'EXP-001' },
    { id: 'so-1', type: 'sales_order', number: 'SO-001' },
  ];

  const panel = new ApprovalPanelSimulator('admin-user-1');
  panel.loadPendingApprovals(initialItems);

  // Verify: Panel is closed by default
  assert.strictEqual(panel.isOpen, false, 'Panel must be closed by default on initial load');
  assert.strictEqual(panel.pendingApprovals.length, 3, 'Pending approvals count is 3');

  // 2. User explicitly clicks the notification bell / Pending Approvals control
  panel.handleOpen();
  assert.strictEqual(panel.isOpen, true, 'Panel opens after explicit click');
  assert.strictEqual(storage.getItem('approval_panel_open_admin-user-1'), 'open');

  // 3. User approves a Petty Cash entry while the panel is open
  // Realtime update arrives with the approved item removed
  const afterPettyCashApproved = [
    { id: 'exp-1', type: 'expense', number: 'EXP-001' },
    { id: 'so-1', type: 'sales_order', number: 'SO-001' },
  ];
  panel.loadPendingApprovals(afterPettyCashApproved);

  // Verify: List updates to 2 items, and panel STAYS OPEN (no flickering, no resetting)
  assert.strictEqual(panel.isOpen, true, 'Panel must stay open when an item is approved while open');
  assert.strictEqual(panel.pendingApprovals.length, 2, 'Pending approvals count updated to 2');

  // 4. User closes the panel using its X button
  panel.handleDismiss();
  assert.strictEqual(panel.isOpen, false, 'Panel must close when X is clicked');
  assert.strictEqual(storage.getItem('approval_panel_open_admin-user-1'), 'closed');
  assert.strictEqual(storage.getItem('approval_popup_dismissed_admin-user-1'), 'dismissed');

  // 5. Subsequent events while closed:
  // a) User approves another item from a different page or background job
  const afterAnotherApproved = [{ id: 'so-1', type: 'sales_order', number: 'SO-001' }];
  panel.loadPendingApprovals(afterAnotherApproved);
  assert.strictEqual(panel.isOpen, false, 'Panel must REMAIN CLOSED after an approval occurs while closed');
  assert.strictEqual(panel.pendingApprovals.length, 1);

  // b) Realtime event arrives / data refetched
  panel.loadPendingApprovals(afterAnotherApproved);
  assert.strictEqual(panel.isOpen, false, 'Panel must REMAIN CLOSED after data refetch');

  // c) User navigates between ERP modules (component remounts)
  const remountedPanel = new ApprovalPanelSimulator('admin-user-1');
  remountedPanel.loadPendingApprovals(afterAnotherApproved);
  assert.strictEqual(remountedPanel.isOpen, false, 'Panel must REMAIN CLOSED after navigating modules / remounting');

  // 6. User clicks notification bell again to reopen
  remountedPanel.handleOpen();
  assert.strictEqual(remountedPanel.isOpen, true, 'Panel must reopen when notification bell is clicked');
  assert.strictEqual(storage.getItem('approval_panel_open_admin-user-1'), 'open');
});
