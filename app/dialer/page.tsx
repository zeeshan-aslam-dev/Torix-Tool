import prisma from "../../lib/prisma";
import styles from "./page.module.css";
import { Mail, UserX, CalendarCheck } from "lucide-react";

export default async function DialerPage({
  searchParams,
}: {
  searchParams: { lead?: string };
}) {
  const leadId = searchParams.lead ? parseInt(searchParams.lead) : undefined;
  
  // Get a lead to call, either the one requested or the oldest HOT lead not called
  let lead = null;
  if (leadId) {
    lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { contact: true, outreach: true } });
  } else {
    lead = await prisma.lead.findFirst({
      where: { tag: "HOT", outreach: { callStatus: "Not called" } },
      include: { contact: true, outreach: true }
    });
    
    // Fallback if no specific HOT lead is pending
    if (!lead) {
      lead = await prisma.lead.findFirst({
        where: { tag: "HOT" },
        include: { contact: true, outreach: true }
      });
    }
  }

  return (
    <div className="page-container">
      <div style={{ marginBottom: 24 }}>
        <h1>Sales Dialer & Script</h1>
        <p style={{ color: 'var(--text-secondary)' }}>Follow the script, log the outcome, move to the next lead.</p>
      </div>

      {!lead ? (
        <div className="glass-panel" style={{ padding: 48, textAlign: 'center' }}>
          <h2>No pending leads to call!</h2>
          <p style={{ color: 'var(--text-secondary)' }}>Go to your CRM or Pipeline to generate new leads.</p>
        </div>
      ) : (
        <div className={styles.dialerContainer}>
          <div className={`glass-panel ${styles.leadPanel}`}>
            <div className={styles.leadHeader}>
              <h2 style={{ fontSize: 18, marginBottom: 4 }}>{lead.organization}</h2>
              <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                {lead.city}, {lead.state}
              </div>
            </div>

            <div>
              <div className={styles.leadDetail}>
                <span className={styles.detailLabel}>Decision Maker</span>
                <span className={styles.detailValue}>
                  {lead.contact?.decisionMakerName || "Unknown"}
                </span>
              </div>
              <div className={styles.leadDetail}>
                <span className={styles.detailLabel}>Phone Number</span>
                <span className={styles.detailValue} style={{ fontSize: 18, fontWeight: 600, color: 'var(--brand-primary)' }}>
                  {lead.contact?.decisionMakerPhone || "(Not provided)"}
                </span>
              </div>
              <div className={styles.leadDetail}>
                <span className={styles.detailLabel}>Email Address</span>
                <span className={styles.detailValue}>
                  {lead.contact?.decisionMakerEmail || "Not provided"}
                </span>
              </div>
              <div className={styles.leadDetail}>
                <span className={styles.detailLabel}>Practice Size</span>
                <span className={styles.detailValue}>
                  {lead.n_providers_at_location} Providers, {lead.n_locations_detected} Location(s)
                </span>
              </div>
            </div>

            <div className={styles.actionButtons}>
              <button className="btn btn-primary" style={{ width: '100%', padding: '12px' }}>
                <CalendarCheck size={18} /> Booked Meeting
              </button>
              <button className="btn" style={{ width: '100%', padding: '12px' }}>
                <Mail size={18} /> Requested Email
              </button>
              <button className="btn" style={{ width: '100%', padding: '12px', color: 'var(--status-exclude)' }}>
                <UserX size={18} /> Not Interested / DNC
              </button>
            </div>
          </div>

          <div className={`glass-panel ${styles.scriptPanel}`}>
            <div className={styles.scriptSection}>
              <h3>1. Opener (Past the Gatekeeper)</h3>
              <p className={styles.scriptText}>
                “Hi, this is [Your Name] calling from Torix Solutions — we work with independent {lead.taxonomy || 'practices'} on their medical billing. Who handles billing decisions there, is that something you’d know, or is there someone else I should ask for?”
              </p>
              <div className={styles.scriptNote}>
                <strong>If asked “what is this regarding?”:</strong><br/>
                “We help independent practices like this one reduce claim denials and speed up collections. I’d just like 5 minutes with whoever oversees billing — is that you, or someone else?”
              </div>
            </div>

            <div className={styles.scriptSection}>
              <h3>2. Reaching the Decision Maker</h3>
              <p className={styles.scriptText}>
                “Hi {lead.contact?.decisionMakerName ? lead.contact.decisionMakerName : '[Name]'}, thanks for taking a second. I’ll be quick — we’re a medical billing company working with independent practices in {lead.state}, usually mid-size groups like yours. Quick question: is billing handled in-house right now, or outsourced?”
              </p>
              <div className={styles.scriptNote}>
                <strong>Listen closely:</strong><br/>
                • “In-house, one person” → Politely disengage.<br/>
                • “Outsourced” → Note who they use.<br/>
                • “In-house, small team” → PROCEED TO VALUE PITCH.
              </div>
            </div>

            <div className={styles.scriptSection}>
              <h3>3. Value Pitch</h3>
              <p className={styles.scriptText}>
                “Most of the practices we work with are dealing with slow reimbursements or higher-than-normal denial rates just because billing isn’t their core focus. We handle the full cycle — claims, follow-up, denial management — usually at a lower cost than an in-house hire, and it frees up your staff for patient-facing work.”
              </p>
            </div>

            <div className={styles.scriptSection}>
              <h3>4. Close</h3>
              <p className={styles.scriptText}>
                “I don’t want to take more of your time right now — would it make sense to grab 15 minutes on a call this week, so I can actually understand your current setup and see if there’s a fit? No pressure either way.”
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
