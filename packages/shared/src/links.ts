/** Front-end route for a record — used by notifications, the timeline and global search so links never drift. */
export function entityPath(entityType: string, id: string): string {
  switch (entityType) {
    case 'lead': return `/leads/${id}`;
    case 'opportunity': return `/opportunities/${id}`;
    case 'quotation': case 'quote': return `/quotes/${id}`;
    case 'approval': return '/approvals';
    case 'proforma_invoice': case 'pi': return `/invoices/${id}`;
    case 'sales_order': return `/orders/${id}`;
    case 'dispatch': return `/dispatch/${id}`;
    case 'installation': return '/post-sale?tab=installations';
    case 'discom_application': return '/post-sale?tab=discom';
    case 'subsidy_claim': return '/post-sale?tab=subsidy';
    case 'loan': return '/post-sale?tab=loans';
    case 'warranty_ticket': return '/post-sale?tab=warranty';
    case 'dealer': return `/dealers/${id}`;
    case 'sop_case': return `/dealers?sop_case=${id}`;
    case 'distributor': return `/distributors/${id}`;
    case 'sku': return `/catalogue?sku=${id}`;
    case 'survey': case 'site_survey': return `/leads/${id}?tab=site`;
    default: return '/';
  }
}
