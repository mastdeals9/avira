export interface CellCoord {
  rowId: string;
  field: string;
}

export interface CrmCustomerOption {
  id: string;
  company_name: string;
  contact_person?: string | null;
  email?: string | null;
  phone?: string | null;
}

export type EditableColumnType = 'text' | 'number' | 'date' | 'select' | 'customer';

export interface EditableColumnDef {
  field: string;
  label: string;
  type: EditableColumnType;
  required?: boolean;
  options?: string[];
}

export const PIPELINE_STAGE_VALUES = [
  'new',
  'needs_sourcing',
  'sourcing',
  'price_ready',
  'quoted',
  'quote_sent',
  'negotiation',
  'won',
  'lost',
  'closed',
] as const;

export const PRIORITY_VALUES = ['low', 'medium', 'high', 'urgent'] as const;

export const INQUIRY_EDITABLE_COLUMNS: EditableColumnDef[] = [
  { field: 'inquiry_date', label: 'Date', type: 'date', required: true },
  { field: 'company_name', label: 'Customer', type: 'customer', required: true },
  { field: 'product_name', label: 'Product', type: 'text', required: true },
  { field: 'specification', label: 'Spec', type: 'text' },
  { field: 'quantity', label: 'Qty', type: 'text', required: true },
  { field: 'supplier_name', label: 'Supplier', type: 'text' },
  { field: 'aceerp_no', label: 'ACE ERP No', type: 'text' },
  { field: 'purchase_price', label: 'P.Price', type: 'number' },
  { field: 'offered_price', label: 'O.Price', type: 'number' },
  { field: 'delivery_date', label: 'Delivery Date', type: 'date' },
  { field: 'pipeline_status', label: 'Stage', type: 'select', options: [...PIPELINE_STAGE_VALUES] },
  { field: 'priority', label: 'Priority', type: 'select', options: [...PRIORITY_VALUES] },
  { field: 'mail_subject', label: 'Subject', type: 'text' },
  { field: 'remarks', label: 'Remarks', type: 'text' },
];

export type NavDirection = 'next' | 'prev' | 'up' | 'down' | 'left' | 'right';

export function getNextCellCoord(
  visibleRowIds: string[],
  visibleEditableFields: string[],
  current: CellCoord,
  direction: NavDirection
): CellCoord | null {
  if (visibleRowIds.length === 0 || visibleEditableFields.length === 0) return null;
  const rowIdx = visibleRowIds.indexOf(current.rowId);
  const colIdx = visibleEditableFields.indexOf(current.field);
  if (rowIdx === -1 || colIdx === -1) {
    return { rowId: visibleRowIds[0], field: visibleEditableFields[0] };
  }

  switch (direction) {
    case 'next': {
      if (colIdx + 1 < visibleEditableFields.length) {
        return { rowId: visibleRowIds[rowIdx], field: visibleEditableFields[colIdx + 1] };
      }
      if (rowIdx + 1 < visibleRowIds.length) {
        return { rowId: visibleRowIds[rowIdx + 1], field: visibleEditableFields[0] };
      }
      return null;
    }
    case 'prev': {
      if (colIdx - 1 >= 0) {
        return { rowId: visibleRowIds[rowIdx], field: visibleEditableFields[colIdx - 1] };
      }
      if (rowIdx - 1 >= 0) {
        return {
          rowId: visibleRowIds[rowIdx - 1],
          field: visibleEditableFields[visibleEditableFields.length - 1],
        };
      }
      return null;
    }
    case 'right': {
      if (colIdx + 1 < visibleEditableFields.length) {
        return { rowId: visibleRowIds[rowIdx], field: visibleEditableFields[colIdx + 1] };
      }
      return null;
    }
    case 'left': {
      if (colIdx - 1 >= 0) {
        return { rowId: visibleRowIds[rowIdx], field: visibleEditableFields[colIdx - 1] };
      }
      return null;
    }
    case 'down': {
      if (rowIdx + 1 < visibleRowIds.length) {
        return { rowId: visibleRowIds[rowIdx + 1], field: visibleEditableFields[colIdx] };
      }
      return null;
    }
    case 'up': {
      if (rowIdx - 1 >= 0) {
        return { rowId: visibleRowIds[rowIdx - 1], field: visibleEditableFields[colIdx] };
      }
      return null;
    }
  }
}

/**
 * Parse tab-separated clipboard text from Excel / Google Sheets into a 2D string matrix.
 */
export function parseClipboardGrid(rawText: string): string[][] {
  if (!rawText) return [];
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  // Trim single trailing empty line added by Excel copy
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((line) => line.split('\t').map((cell) => cell.trim()));
}

export interface PasteCellError {
  rowId: string;
  field: string;
  message: string;
}

export interface PasteRowPatch {
  rowId: string;
  patch: Record<string, any>;
}

export interface PasteBuildResult {
  patches: PasteRowPatch[];
  errors: PasteCellError[];
}

function isValidIsoDate(val: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const d = new Date(`${val}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === val;
}

/**
 * Map a 2D clipboard matrix onto visible rows & editable columns starting at `startCoord`.
 * Validates each cell, preserves untouched cells, and never creates duplicate customers or inquiries.
 */
export function buildPasteUpdates(
  visibleRowIds: string[],
  visibleEditableFields: string[],
  startCoord: CellCoord,
  matrix: string[][],
  customers: CrmCustomerOption[]
): PasteBuildResult {
  const patches: PasteRowPatch[] = [];
  const errors: PasteCellError[] = [];

  const startRowIdx = visibleRowIds.indexOf(startCoord.rowId);
  const startColIdx = visibleEditableFields.indexOf(startCoord.field);
  if (startRowIdx === -1 || startColIdx === -1 || matrix.length === 0) {
    return { patches, errors };
  }

  const colDefMap = new Map(INQUIRY_EDITABLE_COLUMNS.map((c) => [c.field, c]));
  const customerByName = new Map<string, CrmCustomerOption>();
  for (const c of customers) {
    const key = c.company_name.trim().toLowerCase();
    if (key && !customerByName.has(key)) {
      customerByName.set(key, c);
    }
  }

  for (let rOffset = 0; rOffset < matrix.length; rOffset++) {
    const targetRowIdx = startRowIdx + rOffset;
    if (targetRowIdx >= visibleRowIds.length) break;
    const rowId = visibleRowIds[targetRowIdx];
    const rowValues = matrix[rOffset];
    const patch: Record<string, any> = {};

    for (let cOffset = 0; cOffset < rowValues.length; cOffset++) {
      const targetColIdx = startColIdx + cOffset;
      if (targetColIdx >= visibleEditableFields.length) break;
      const field = visibleEditableFields[targetColIdx];
      const rawVal = rowValues[cOffset];
      const def = colDefMap.get(field);
      if (!def) continue;

      if (def.required && rawVal === '') {
        errors.push({ rowId, field, message: `${def.label} cannot be empty` });
        continue;
      }

      if (def.type === 'number') {
        if (rawVal === '' || rawVal === '-') {
          patch[field] = null;
        } else {
          const cleaned = rawVal.replace(/[$,\s]/g, '');
          const num = Number(cleaned);
          if (!Number.isFinite(num) || num < 0) {
            errors.push({ rowId, field, message: `Invalid ${def.label}: "${rawVal}"` });
          } else {
            patch[field] = num;
          }
        }
      } else if (def.type === 'date') {
        if (rawVal === '' || rawVal === '-') {
          if (def.required) {
            errors.push({ rowId, field, message: `${def.label} is required` });
          } else {
            patch[field] = null;
          }
        } else if (!isValidIsoDate(rawVal)) {
          errors.push({ rowId, field, message: `Invalid date "${rawVal}" (expected YYYY-MM-DD)` });
        } else {
          patch[field] = rawVal;
        }
      } else if (def.type === 'select') {
        const normalized = rawVal.toLowerCase().replace(/\s+/g, '_');
        if (def.options && !def.options.includes(normalized)) {
          errors.push({ rowId, field, message: `Invalid ${def.label}: "${rawVal}"` });
        } else {
          patch[field] = normalized;
        }
      } else if (def.type === 'customer') {
        const matched = customerByName.get(rawVal.toLowerCase());
        if (!matched) {
          errors.push({
            rowId,
            field,
            message: `Customer "${rawVal}" not found in CRM contacts (select from dropdown)`,
          });
        } else {
          patch.crm_contact_id = matched.id;
          patch.company_name = matched.company_name;
        }
      } else {
        patch[field] = rawVal === '' ? null : rawVal;
      }
    }

    if (Object.keys(patch).length > 0) {
      patches.push({ rowId, patch });
    }
  }

  return { patches, errors };
}

export interface CustomerInquiryGroup<T extends { id: string; crm_contact_id?: string | null; customer_id?: string | null; company_name?: string | null }> {
  groupKey: string;
  customerId: string | null;
  companyName: string;
  isUnlinked: boolean;
  items: T[];
}

/**
 * Deterministic, stable customer grouping for inquiries.
 * - Linked inquiries group by `crm_contact_id` (or fallback `customer_id`).
 * - Unlinked inquiries with a non-empty company_name group by normalized name (`unlinked-name:...`),
 *   and inquiries without a company name stay isolated (`unlinked-id:...`) so unrelated rows never merge.
 */
export function groupInquiriesByCustomer<
  T extends { id: string; crm_contact_id?: string | null; customer_id?: string | null; company_name?: string | null }
>(rows: T[]): CustomerInquiryGroup<T>[] {
  const groups = new Map<string, CustomerInquiryGroup<T>>();

  for (const row of rows) {
    const contactId = row.crm_contact_id || null;
    const customerId = row.customer_id || null;
    const trimmedCompany = (row.company_name || '').trim();

    let groupKey: string;
    let isUnlinked = false;
    if (contactId) {
      groupKey = `contact:${contactId}`;
    } else if (customerId) {
      groupKey = `customer:${customerId}`;
    } else if (trimmedCompany) {
      groupKey = `unlinked-name:${trimmedCompany.toLowerCase()}`;
      isUnlinked = true;
    } else {
      groupKey = `unlinked-id:${row.id}`;
      isUnlinked = true;
    }

    const existing = groups.get(groupKey);
    if (existing) {
      existing.items.push(row);
    } else {
      groups.set(groupKey, {
        groupKey,
        customerId: contactId || customerId,
        companyName: trimmedCompany || 'Unlinked Inquiry',
        isUnlinked,
        items: [row],
      });
    }
  }

  return Array.from(groups.values());
}
