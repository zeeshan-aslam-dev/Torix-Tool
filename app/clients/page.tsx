import prisma from "../../lib/prisma";

export default async function ClientsPage() {
  const clients = await prisma.client.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return (
    <div className="page-container">
      <div style={{ marginBottom: 24 }}>
        <h1>Won Clients & Invoicing</h1>
        <p style={{ color: 'var(--text-secondary)' }}>Manage your active billing clients here.</p>
      </div>

      <div className="glass-panel" style={{ padding: 48, textAlign: 'center' }}>
        {clients.length === 0 ? (
          <>
            <h2>No active clients yet</h2>
            <p style={{ color: 'var(--text-secondary)' }}>When you win a lead, they will appear here for monthly invoicing.</p>
          </>
        ) : (
          <p>Clients list will be rendered here.</p>
        )}
      </div>
    </div>
  );
}
