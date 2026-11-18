/* =========================================================================
   prisma/seed.ts
   Minimal fixture for Slice 1 UAT: 3 cases, 3 visits.
   Run with: npx tsx prisma/seed.ts
   Safe to re-run — upserts by id.
   ========================================================================= */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CASES = [
  {
    id: "AY-2026-9001",
    name: "Noluthando Mbeki",
    household: "Mbeki household",
    project: "Ndlovu Extension Phase 2",
    location: "Ward 14 · Mthatha",
    source: "Municipal source list",
    verification: "Awaiting review",
    verificationTone: "warning",
    subsidy: "Awaiting department",
    subsidyTone: "warning",
    readiness: "Not started",
    nextAction: "Complete field verification",
    updated: "Seed fixture",
    members: 5,
    site: "Plot ND-0142",
  },
  {
    id: "AY-2026-9002",
    name: "Siyabonga Dlamini",
    household: "Dlamini household",
    project: "Ndlovu Extension Phase 2",
    location: "Ward 14 · Mthatha",
    source: "Field intake",
    verification: "Awaiting review",
    verificationTone: "warning",
    subsidy: "Not started",
    subsidyTone: "neutral",
    readiness: "Not started",
    nextAction: "Field verification",
    updated: "Seed fixture",
    members: 3,
    site: "Plot ND-0151",
  },
  {
    id: "AY-2026-9003",
    name: "Zimasa Qwabe",
    household: "Qwabe household",
    project: "Mbashe Rural Housing",
    location: "Village 2 · Dutywa",
    source: "Approved register",
    verification: "Internally verified",
    verificationTone: "success",
    subsidy: "Officially approved",
    subsidyTone: "success",
    readiness: "Ready for works",
    nextAction: "Confirm builder pack",
    updated: "Seed fixture",
    members: 4,
    site: "Plot MB-0207",
  },
];

const FIELDWORKER = "Lindiwe Ndlovu";

async function main() {
  for (const c of CASES) {
    await prisma.caseRecord.upsert({ where: { id: c.id }, create: c, update: c });
  }

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  const VISITS = [
    { id: "V-SEED-001", caseId: "AY-2026-9001", scheduledFor: tomorrow, status: "assigned" },
    { id: "V-SEED-002", caseId: "AY-2026-9002", scheduledFor: tomorrow, status: "assigned" },
    { id: "V-SEED-003", caseId: "AY-2026-9003", scheduledFor: tomorrow, status: "assigned" },
  ];

  for (const v of VISITS) {
    await prisma.visit.upsert({
      where: { id: v.id },
      create: { ...v, assignedTo: FIELDWORKER },
      update: { scheduledFor: v.scheduledFor, assignedTo: FIELDWORKER },
    });
  }

  console.log(`Seeded ${CASES.length} cases and ${VISITS.length} visits.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
