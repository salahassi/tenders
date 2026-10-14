import type { AppState, Opportunity, Proposal, Requirement } from "../../types";

/** All buyers, contracts, rates, and documents below are fabricated fixtures. */
export function createSeedState(now: Date = new Date()): AppState {
  const calendar = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) =>
    calendar.find((item) => item.type === type)?.value ?? "";
  const today = new Date(
    `${part("year")}-${part("month")}-${part("day")}T12:00:00+03:00`,
  );
  const day = (offset: number) =>
    new Date(today.getTime() + offset * 86_400_000).toISOString();
  const ago = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000).toISOString();
  const requirements = (prefix: string, complete = false): Requirement[] => [
    {
      id: `${prefix}-r1`,
      text: "Provide a phased implementation plan with defined acceptance criteria.",
      source: "Synthetic RFP §2.1 · Implementation",
      mandatory: true,
      status: complete ? "addressed" : "open",
      response: complete
        ? "Discovery, configuration, validation, and handover are separated by documented acceptance checkpoints."
        : "",
    },
    {
      id: `${prefix}-r2`,
      text: "Apply role-based access and record security-relevant actions.",
      source: "Synthetic RFP §3.2 · Access",
      mandatory: true,
      status: "addressed",
      response:
        "The proposed design uses least-privilege roles and an application audit trail; access rules will be verified during acceptance.",
    },
    {
      id: `${prefix}-r3`,
      text: "Define integration assumptions and the client responsibilities.",
      source: "Synthetic RFP §3.3 · Integration",
      mandatory: true,
      status: "addressed",
      response:
        "The client provides an approved test environment, documented APIs, representative synthetic records, and a technical representative.",
    },
    {
      id: `${prefix}-r4`,
      text: "Include administrator training and a support handover.",
      source: "Synthetic RFP §4.1 · Handover",
      mandatory: true,
      status: "addressed",
      response:
        "Two synthetic training sessions and an operations guide are included in the demonstration scope.",
    },
    {
      id: `${prefix}-r5`,
      text: "Describe an optional analytics capability separately.",
      source: "Synthetic RFP §4.2 · Optional capability",
      mandatory: false,
      status: "open",
      response: "",
    },
  ];
  const specs: Array<
    Pick<
      Opportunity,
      | "title"
      | "buyer"
      | "description"
      | "category"
      | "tags"
      | "score"
      | "coverage"
      | "status"
      | "value"
    > & { due: number }
  > = [
    {
      title: "Enterprise AI enablement and intelligent service desk",
      buyer: "Noor Utilities — fictional",
      description:
        "A synthetic utility group seeks a phased AI enablement program and an internal service assistant grounded in approved knowledge. The scope includes service request workflows, access controls, evaluation, and a managed handover.",
      category: "Artificial intelligence",
      tags: ["AI enablement", "Energy", "RAG", "Service desk"],
      score: 94,
      coverage: 90,
      status: "in_progress",
      value: null,
      due: 12,
    },
    {
      title: "Unified API gateway and integration services",
      buyer: "Rawan Civic Services — fictional",
      description:
        "Design an API catalog and connect three existing applications using approved interfaces. Includes access governance, API lifecycle management, and integration monitoring. This advertisement is fabricated for the trial.",
      category: "Systems integration",
      tags: ["APIs", "Integration", "Public services"],
      score: 91,
      coverage: 85,
      status: "shortlisted",
      value: null,
      due: 6,
    },
    {
      title: "Digital workflow modernization for service operations",
      buyer: "Madar Logistics — fictional",
      description:
        "Replace email-based approvals with configurable workflows and operational dashboards. The synthetic scope includes process discovery, workflow implementation, user acceptance, and training.",
      category: "Digital transformation",
      tags: ["Workflow", "Logistics", "Automation"],
      score: 88,
      coverage: 85,
      status: "in_progress",
      value: null,
      due: 19,
    },
    {
      title: "Predictive maintenance discovery and pilot design",
      buyer: "Horizon Asset Company — fictional",
      description:
        "Assess maintenance records and design a limited predictive pilot for critical equipment. Data history, instrumentation coverage, and access permissions require clarification before a delivery commitment.",
      category: "Artificial intelligence",
      tags: ["Predictive analytics", "Energy", "Data readiness"],
      score: 84,
      coverage: 65,
      status: "new",
      value: null,
      due: 24,
    },
    {
      title: "Knowledge portal and search experience",
      buyer: "Bayt Learning Foundation — fictional",
      description:
        "Deliver a searchable internal knowledge portal with document permissions, bilingual navigation, and a documented handover. Synthetic requirements and proposal are included to demonstrate approval controls.",
      category: "Software engineering",
      tags: ["Knowledge", "Search", "Bilingual"],
      score: 89,
      coverage: 95,
      status: "in_progress",
      value: null,
      due: 9,
    },
    {
      title: "AI-assisted document processing feasibility study",
      buyer: "Rimal Insurance Services — fictional",
      description:
        "Evaluate document extraction, routing, and human review using representative records. A discovery study is requested; production access and processing volumes are not yet stated.",
      category: "Artificial intelligence",
      tags: ["Document AI", "Discovery", "Insurance"],
      score: 79,
      coverage: 70,
      status: "new",
      value: null,
      due: 15,
    },
    {
      title: "Enterprise applications enhancement program",
      buyer: "Wadi Development Office — fictional",
      description: "",
      category: "Software engineering",
      tags: ["Applications", "Clarification needed"],
      score: 75,
      coverage: 35,
      status: "deferred",
      value: null,
      due: 4,
    },
    {
      title: "Cybersecurity operations reporting dashboard",
      buyer: "Sahil Retail Group — fictional",
      description:
        "Build a consolidated operational dashboard using existing security platform APIs. Includes report automation and data access controls; replacement of security products is excluded in this synthetic advertisement.",
      category: "Systems integration",
      tags: ["Dashboards", "Cybersecurity", "APIs"],
      score: 82,
      coverage: 80,
      status: "new",
      value: null,
      due: 21,
    },
    {
      title: "Smart building analytics and occupancy reporting",
      buyer: "Cedar Facilities — fictional",
      description:
        "Combine approved building-system metrics with occupancy summaries to support facilities planning. Sensor deployment and civil works are outside the software package in this synthetic example.",
      category: "Digital transformation",
      tags: ["Analytics", "Facilities", "IoT"],
      score: 76,
      coverage: 75,
      status: "shortlisted",
      value: null,
      due: 28,
    },
    {
      title: "Construction of a new electrical substation",
      buyer: "North Dune Energy — fictional",
      description:
        "Civil construction, installation, and commissioning of a new electrical substation. No software engineering or AI service component is specified. This fixture demonstrates why sector interest alone is insufficient.",
      category: "Civil construction",
      tags: ["Energy", "Civil works", "Outside capability"],
      score: 12,
      coverage: 95,
      status: "declined",
      value: null,
      due: 17,
    },
    {
      title: "Supply of office furniture and meeting-room fittings",
      buyer: "Olive Business Park — fictional",
      description:
        "Supply and install furniture for a new office. This synthetic opportunity has no relevant software or digital transformation scope.",
      category: "General procurement",
      tags: ["Supply", "Furniture", "Outside capability"],
      score: 5,
      coverage: 95,
      status: "declined",
      value: null,
      due: 10,
    },
    {
      title: "Customer portal accessibility and usability review",
      buyer: "Vista Mobility — fictional",
      description:
        "Assess an existing customer portal, document usability barriers, and deliver a prioritized remediation backlog. The deadline has passed in this fixture; no bid result should be inferred.",
      category: "Software engineering",
      tags: ["Accessibility", "User experience", "Portal"],
      score: 81,
      coverage: 80,
      status: "deferred",
      value: null,
      due: -2,
    },
  ];
  const opportunities: Opportunity[] = specs.map((spec, index) => {
    const id = `opp-${index + 1}`;
    const { due, ...fields } = spec;
    return {
      ...fields,
      id,
      reference: `DEMO-${String(index + 1).padStart(4, "0")}`,
      deadline: day(due),
      sourceId: index % 2 ? "src-2" : "src-1",
      saved: [0, 1, 4].includes(index),
      createdAt: day(-index - 1),
      documents: [],
      requirements: [],
      gaps: [],
      acquisition: "not_requested",
      language: "en",
      sourceUrl: `https://example.com/synthetic-tenders/${id}`,
    };
  });
  for (const [index, complete] of [
    [0, false],
    [2, true],
    [4, true],
  ] as const) {
    const opportunity = opportunities[index];
    opportunity.requirements = requirements(opportunity.id, complete);
    opportunity.gaps = [
      {
        id: `${opportunity.id}-g1`,
        question: "Which integration APIs and test access are available?",
        answer: complete
          ? "For this synthetic demonstration, three documented test APIs and a sandbox are assumed available."
          : "",
        required: true,
      },
      {
        id: `${opportunity.id}-g2`,
        question: "Confirm the commercial validity and payment milestones.",
        answer: complete
          ? "Synthetic terms: valid for 30 days; 30% on kickoff, 40% on accepted configuration, and 30% on handover."
          : "",
        required: true,
      },
      {
        id: `${opportunity.id}-g3`,
        question: "Should the optional analytics module be included?",
        answer: "Keep it separate from the base scope for the demo.",
        required: false,
      },
    ];
    const text = `SYNTHETIC RFP — DEMONSTRATION ONLY\n${opportunity.title}\nBuyer: ${opportunity.buyer}\n\n${opportunity.requirements.map((r) => `${r.source}\n${r.text}`).join("\n\n")}\n\nNo real procurement, personal data, or company commitments are represented.`;
    opportunity.documents = [
      {
        id: `${opportunity.id}-doc1`,
        name: `Synthetic_RFP_${opportunity.reference}.txt`,
        size: new TextEncoder().encode(text).length,
        uploadedAt: ago(260 + index * 30),
        text,
        status: "ready",
        classification: "synthetic",
        hash: `fixture:${opportunity.reference}:v1`,
      },
    ];
    opportunity.acquisition = "document_available";
  }
  const proposals: Proposal[] = [0, 2, 4].map((index, order) => {
    const opportunity = opportunities[index];
    return {
      id: `prop-${order + 1}`,
      opportunityId: opportunity.id,
      title: opportunity.title,
      status: order === 2 ? "approved" : order === 1 ? "in_review" : "draft",
      version: order === 2 ? 3 : 1,
      approvalVersion: order === 2 ? 3 : null,
      updatedAt: ago(32 + order * 80),
      sections: [
        {
          id: "executive-summary",
          title: "Executive summary",
          body: `This synthetic proposal describes a focused implementation for ${opportunity.buyer}. The approach combines discovery, a bounded implementation, acceptance testing, and a practical operations handover. It demonstrates a consistent proposal format and does not represent a commercial offer.`,
          evidence: ["Synthetic RFP §2.1"],
        },
        {
          id: "scope",
          title: "Scope and approach",
          body: "Confirm the operational problem and acceptance criteria during discovery. Configure the agreed workflows, connect the approved test interfaces, validate access permissions, and demonstrate the completed journey with synthetic data. Production rollout remains subject to separately approved readiness and access checks.",
          evidence: ["Synthetic RFP §2.1", "Synthetic RFP §3.3"],
        },
        {
          id: "architecture",
          title: "Proposed solution",
          body: "Use an authenticated web application, a controlled application API, and a relational data store. Keep integration credentials on the server and limit access by role. The final hosting pattern and sizing require confirmed workload and availability targets; no server quantity is asserted in this demonstration.",
          evidence: ["Synthetic RFP §3.2", "Synthetic RFP §3.3"],
        },
        {
          id: "delivery",
          title: "Delivery and acceptance",
          body: "Stage 1 confirms requirements and integration prerequisites. Stage 2 implements the agreed capability. Stage 3 validates functional behavior, access rules, and failure handling. Stage 4 delivers training and an operations guide. Completion requires documented user acceptance and resolution of mandatory findings.",
          evidence: ["Synthetic RFP §2.1", "Synthetic RFP §4.1"],
        },
        {
          id: "commercial-assumptions",
          title: "Commercial assumptions",
          body:
            order === 0
              ? "All displayed rates are fabricated test inputs. [INPUT REQUIRED: confirm validity period and payment milestones]. No staffing availability, credentials, or supplier prices are asserted."
              : "Synthetic demonstration terms only: validity is 30 days, with payments of 30% on kickoff, 40% on accepted configuration, and 30% on handover. Rates and the 15% tax input are test values, not a statement of applicable taxation or a real supplier offer.",
          evidence: ["Synthetic commercial fixture"],
        },
      ],
      lines: [
        {
          id: `p${order}-l1`,
          description: "Solution design and implementation — synthetic rate",
          quantity: "10",
          unit: "person-days",
          rate: "1000",
          optional: false,
        },
        {
          id: `p${order}-l2`,
          description: "Training and handover sessions — synthetic rate",
          quantity: "2",
          unit: "sessions",
          rate: "500",
          optional: false,
        },
        {
          id: `p${order}-l3`,
          description: "Optional analytics discovery — synthetic rate",
          quantity: "2",
          unit: "person-days",
          rate: "1000",
          optional: true,
        },
      ],
      pricingMode: "markup",
      currency: "SAR",
      percentage: "20",
      contingency: "10",
      tax: "15",
      comments:
        order === 1
          ? [
              {
                id: "comment-1",
                body: "Demo reviewer: the scope and handover are clear. Owner review is still required before final approval.",
                at: ago(75),
                author: "Demo Reviewer",
              },
            ]
          : [],
    };
  });
  return {
    schemaVersion: 1,
    knowledgeDocuments: [],
    opportunities,
    proposals,
    sources: [
      {
        id: "src-1",
        name: "Public-sector opportunity fixtures",
        type: "rss",
        url: "https://example.com/fixtures/public-tenders.xml",
        status: "approved",
        health: "healthy",
        lastRun: ago(45),
        nextRun: null,
        count: 6,
        policy:
          "Synthetic local feed only. Approval demonstrates the workflow; no live portal is connected or polled.",
        tags: ["Public services", "Energy", "Software"],
      },
      {
        id: "src-2",
        name: "Enterprise procurement fixtures",
        type: "json_feed",
        url: "https://example.com/fixtures/enterprise-tenders.json",
        status: "approved",
        health: "healthy",
        lastRun: ago(48),
        nextRun: null,
        count: 6,
        policy:
          "Fabricated JSON advertisements included with the frontend demo. No network collection takes place.",
        tags: ["Enterprise", "Integration", "AI"],
      },
      {
        id: "src-3",
        name: "Procurement directory candidate",
        type: "link_directory",
        url: "https://example.com/fixtures/procurement-directory",
        status: "proposed",
        health: "unknown",
        lastRun: null,
        nextRun: null,
        count: 0,
        policy:
          "Synthetic source candidate awaiting review. A live connector would require verified access conditions and backend activation.",
        tags: ["Directory", "Needs review"],
      },
      {
        id: "manual",
        name: "Manual entries and imports",
        type: "manual",
        url: "",
        status: "approved",
        health: "unknown",
        lastRun: null,
        nextRun: null,
        count: 0,
        policy:
          "User-entered opportunities in this browser. This source does not make network requests.",
        tags: ["Manual"],
      },
    ],
    knowledge: [
      {
        id: "k1",
        category: "capability",
        title: "AI discovery and solution design",
        content:
          "Synthetic profile: assess readiness, define evaluation criteria, and design bounded AI use cases. This fixture does not verify any real company credential.",
        verified: true,
        evidence: "Approved synthetic company profile v1",
      },
      {
        id: "k2",
        category: "capability",
        title: "Software engineering and integration",
        content:
          "Synthetic profile: web applications, workflow automation, documented API integration, testing, and technical handover.",
        verified: true,
        evidence: "Approved synthetic company profile v1",
      },
      {
        id: "k3",
        category: "exclusion",
        title: "Civil works and commodity supply",
        content:
          "Exclude pure civil construction, furniture supply, and equipment installation with no software or integration scope. A preferred sector alone is not enough.",
        verified: true,
        evidence: "Synthetic qualification rules v1",
      },
      {
        id: "k4",
        category: "company",
        title: "Company registration and certifications",
        content:
          "Not supplied. Real registration details, credentials, references, and staff availability must be verified before use in a proposal.",
        verified: false,
        evidence: "Awaiting owner input",
      },
      {
        id: "k5",
        category: "rate",
        title: "Demo implementation day rate",
        content:
          "SAR 1,000 per person-day. This is a fabricated financial test input, not an actual internal cost or supplier quote.",
        verified: true,
        evidence: "Synthetic pricing fixture",
      },
      {
        id: "k6",
        category: "template",
        title: "Technical and financial proposal style",
        content:
          "Use clear, evidence-based prose, explicit assumptions, native headings, and separate technical and financial volumes. Never transfer customer names or commercial commitments from an example.",
        verified: true,
        evidence: "Neutral demo writing guide v1",
      },
    ],
    jobs: [
      {
        id: "job-1",
        type: "Fixture classification",
        target: opportunities[0].title,
        status: "completed",
        progress: 100,
        attempt: 1,
        message: "Deterministic demo assessment saved. No model was called.",
        createdAt: ago(42),
      },
      {
        id: "job-2",
        type: "Live collection",
        target: "Connected sources",
        status: "blocked",
        progress: 0,
        attempt: 0,
        message:
          "Backend not connected. Configure and verify a server-side scheduler before live collection.",
        createdAt: ago(40),
      },
      {
        id: "job-3",
        type: "Live proposal generation",
        target: opportunities[0].title,
        status: "blocked",
        progress: 0,
        attempt: 0,
        message:
          "Live inference is unavailable in this frontend. Use the clearly labeled demo draft action.",
        createdAt: ago(35),
      },
    ],
    notifications: [
      {
        id: "note-1",
        title: "A strong fit is ready for review",
        body: "The synthetic AI enablement opportunity matches the demo capability profile. Review its evidence and open questions.",
        href: "/opportunities/opp-1",
        read: false,
        createdAt: ago(42),
      },
      {
        id: "note-2",
        title: "Two decisions are needed",
        body: "Confirm integration access and commercial terms before approving the AI enablement draft.",
        href: "/proposals/prop-1",
        read: false,
        createdAt: ago(32),
      },
      {
        id: "note-3",
        title: "Workflow proposal awaits review",
        body: "A complete synthetic draft is ready for an owner review.",
        href: "/proposals/prop-2",
        read: true,
        createdAt: ago(75),
      },
    ],
    audit: [
      {
        id: "audit-1",
        action: "Demo workspace initialized",
        target: "Synthetic fixtures only",
        at: ago(300),
        actor: "Demo Owner",
      },
      {
        id: "audit-2",
        action: "Synthetic RFP accepted",
        target: opportunities[0].title,
        at: ago(260),
        actor: "Demo Editor",
      },
      {
        id: "audit-3",
        action: "Draft saved",
        target: opportunities[0].title,
        at: ago(32),
        actor: "Demo Editor",
      },
      {
        id: "audit-4",
        action: "Demo version approved",
        target: opportunities[4].title,
        at: ago(192),
        actor: "Demo Owner",
      },
    ],
    settings: {
      role: "Owner",
      companyName: "Your company",
      dailyCallLimit: 50,
      inputTokenLimit: 250000,
      outputTokenLimit: 50000,
      pollHours: 6,
      retentionDays: 90,
    },
  };
}
