import prisma from "../../lib/prisma";
import styles from "./page.module.css";
import Link from "next/link";
import classNames from "classnames";

export default async function CRMPage() {
  const leads = await prisma.lead.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return (
    <div className="page-container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1>CRM Leads</h1>
          <p style={{ color: 'var(--text-secondary)' }}>Manage and track your filtered leads.</p>
        </div>
      </div>

      <div className={styles.filters}>
        <input type="text" className="input-base" placeholder="Search by organization or city..." style={{ maxWidth: 300 }} />
        <select className="input-base" style={{ maxWidth: 200 }}>
          <option value="">All Tags</option>
          <option value="HOT">Hot Leads</option>
          <option value="VERIFY">Verify</option>
          <option value="EXCLUDE">Excluded</option>
        </select>
      </div>

      <div className={styles.tableContainer}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Organization</th>
              <th>Location</th>
              <th>Providers</th>
              <th>Website</th>
              <th>Tag</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  No leads found. Run the pipeline to import data.
                </td>
              </tr>
            ) : (
              leads.map((lead) => (
                <tr key={lead.id}>
                  <td style={{ fontWeight: 500 }}>{lead.organization}</td>
                  <td>{lead.city}, {lead.state}</td>
                  <td>{lead.n_providers_at_location}</td>
                  <td>
                    {lead.website_found ? (
                      <a href={lead.website_found} target="_blank" rel="noreferrer" className={styles.link}>
                        Visit
                      </a>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>-</span>
                    )}
                  </td>
                  <td>
                    <span className={classNames(styles.tag, {
                      [styles.tagHot]: lead.tag === "HOT",
                      [styles.tagVerify]: lead.tag === "VERIFY",
                      [styles.tagExclude]: lead.tag === "EXCLUDE",
                    })}>
                      {lead.tag}
                    </span>
                  </td>
                  <td>
                    <Link href={`/dialer?lead=${lead.id}`} className="btn">Call</Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
