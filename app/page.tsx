import prisma from "../lib/prisma";
import styles from "./page.module.css";
import { Users, Flame, CheckCircle, Search } from "lucide-react";
import Link from "next/link";

export default async function Dashboard() {
  const totalLeads = await prisma.lead.count();
  const hotLeads = await prisma.lead.count({ where: { tag: "HOT" } });
  const verifiedLeads = await prisma.lead.count({
    where: { tag: "HOT", AND: [{ website_found: { not: null } }, { website_found: { not: "" } }] },
  });
  const clients = await prisma.client.count();

  return (
    <div className="page-container">
      <div className={styles.dashboard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1>Dashboard</h1>
            <p style={{ color: 'var(--text-secondary)' }}>Overview of your Torix Lead Pipeline</p>
          </div>
          <Link href="/pipeline" className="btn btn-primary">
            Start Pipeline Run
          </Link>
        </div>

        <div className={styles.statsGrid}>
          <div className={`glass-panel ${styles.statCard}`}>
            <div className={styles.statHeader}>
              <Users size={18} color="var(--brand-primary)" />
              Total Analyzed Leads
            </div>
            <div className={styles.statValue}>{totalLeads.toLocaleString()}</div>
          </div>
          
          <div className={`glass-panel ${styles.statCard}`}>
            <div className={styles.statHeader}>
              <Flame size={18} color="var(--status-hot)" />
              Hot Leads
            </div>
            <div className={styles.statValue}>{hotLeads.toLocaleString()}</div>
          </div>
          
          <div className={`glass-panel ${styles.statCard}`}>
            <div className={styles.statHeader}>
              <Search size={18} color="var(--status-verify)" />
              Web Verified Leads
            </div>
            <div className={styles.statValue}>{verifiedLeads.toLocaleString()}</div>
          </div>
          
          <div className={`glass-panel ${styles.statCard}`}>
            <div className={styles.statHeader}>
              <CheckCircle size={18} color="var(--status-hot)" />
              Won Clients
            </div>
            <div className={styles.statValue}>{clients.toLocaleString()}</div>
          </div>
        </div>

        <div className={styles.recentSection}>
          <h2>Recent Outreach Activity</h2>
          <div className="glass-panel" style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <p>No recent activity. Start your pipeline or make a cold call to see updates here.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
