# Future Solar CRM — Flow Diagrams (Mermaid)

**Basis:** (1) the company's "Future Solar CRM Flow" chart — six stages, 34 numbered steps; (2) the research report "India solar distributor CRM blueprint" (position as of 26-Oct-2026).
**Renders in:** GitHub, GitLab, Notion, Obsidian, VS Code (Markdown Preview Mermaid Support), mermaid.live.

---

## How to read these diagrams

| Marking | Meaning |
|---|---|
| Node numbers **1–34** | Step numbers taken **exactly** from the company's PDF |
| Node ids starting with **A–Z + number** (e.g. `N1`, `G2`) | Nodes **added from the research** — not in the company's chart |
| **Gold dashed border** | Addition from research (compliance, consent, segmentation, post-dispatch) |
| **Red border** | Hard stop (cannot proceed without fix or approved override) |
| **Amber border** | Warning (proceed with acknowledgement) |

**Ownership colours (from the PDF legend):**

| Colour | Owner |
|---|---|
| Blue | System / CRM |
| Teal | Distributor / DSM |
| Green | End customer |
| Purple | Sales / Techno-commercial |
| Orange | Management / Sales Ops / Accounts |

**Confidence note:** any rule shown inside a diagram that depends on an unverified value is labelled **[config]**. It is read from `rule_config` and is advisory (warning only) until a compliance officer verifies and activates it. See Section 14 for the verify list.

---

## 1. Master flow — company chart plus research extensions

```mermaid
flowchart TD
    classDef sys fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef dist fill:#D5F0EC,stroke:#1B7A6B,color:#16233F
    classDef cust fill:#E3F3EA,stroke:#1B7A4B,color:#16233F
    classDef sales fill:#E8E1F7,stroke:#4A3AA7,color:#16233F
    classDef mgmt fill:#FDEFD3,stroke:#9A5B00,color:#16233F
    classDef add stroke:#BF9000,stroke-width:3px,stroke-dasharray:5 3

    subgraph S0["Stage 0 — Consent and provenance (research addition)"]
        N0["Lead arrives<br/>Website, Call, WhatsApp, Campaign, Referral, Dealer upload"]:::sys
        N0a["Consent ledger entry<br/>notice version, purposes, channels, named recipients"]:::sys
        N0b["DND scrub and WhatsApp opt-in check"]:::sys
    end
    class N0a,N0b add

    subgraph S1["Stage 1 — Inquiry capture and allocation"]
        A1["1 Inquiry captured"]:::sys
        A2["2 Validate and de-duplicate"]:::sys
        A3["3 Capture details"]:::sys
        A4["4 Territory and capability match"]:::sys
        A5["5 Auto-assign to distributor or DSM"]:::dist
        A7["7 Lead acceptance by distributor"]:::dist
    end

    subgraph S2["Stage 2 — Follow-up and lead classification"]
        B8["8 Initial customer contact"]:::dist
        B9["9 Qualification call"]:::dist
        B10["10 Lead temperature"]:::sys
        B11["11 Lead quality score"]:::sys
        B12["12 CRM follow-up engine"]:::sys
    end

    subgraph S3["Stage 3 — Site visit and opportunity development"]
        N3a["Segmentation fork and rule pack<br/>PMSG, RWA, C and I, Open access, KUSUM, Govt"]:::sales
        C14["14 Customer site visit"]:::sales
        C15["15 Requirement capture form"]:::sales
        N3b["DISCOM feasibility tracking"]:::sales
        C16["16 Product recommendation and brand USP"]:::sales
        C17["17 Technical discussion and solution fit"]:::sales
        C18["18 Rate negotiation with end customer"]:::sales
        C19["19 Convert to opportunity"]:::sales
        C20["20 Update opportunity"]:::sales
    end
    class N3a,N3b add

    subgraph S4["Stage 4 — Quotation and approval"]
        N4a["Compliance engine<br/>ALMM, DCR, BIS, GST, price validity"]:::sys
        D21["21 Prepare techno-commercial offer"]:::sales
        D22["22 Internal price review"]:::sales
        D23["23 Approval matrix<br/>Commercial, Compliance, Credit lanes"]:::mgmt
        D24["24 Send quotation to customer"]:::sales
        D25["25 Customer discussion and negotiation"]:::cust
        D27["27 Commercial terms confirmed"]:::sales
    end
    class N4a add

    subgraph S5["Stage 5 — PI, payment and sales order"]
        E28["28 Prepare proforma invoice"]:::mgmt
        E29["29 PI approval and issue"]:::mgmt
        E30["30 Payment or credit verification"]:::mgmt
        E31["31 Customer PO or order confirmation"]:::cust
        E32["32 Create sales order"]:::sys
        E33["33 SO approval and circulation"]:::mgmt
        E34["34 Hand over to dispatch planning"]:::mgmt
    end

    subgraph S6["After dispatch (research addition)"]
        P1["Serial-number dispatch"]:::sys
        P2["Installation and DISCOM commissioning"]:::dist
        P3["Subsidy claim and loan tracking"]:::mgmt
        P4["Warranty, RMA and 5-year O and M"]:::dist
        P5["Channel scorecard and credit review"]:::mgmt
    end
    class P1,P2,P3,P4,P5 add

    N0 --> N0a --> N0b --> A1
    A1 --> A2 --> A3 --> A4 --> A5 --> A7
    A7 --> B8 --> B9 --> B10 --> B11 --> B12
    B12 --> N3a --> C14 --> C15 --> N3b --> C16 --> C17 --> C18 --> C19 --> C20
    C20 --> N4a --> D21 --> D22 --> D23 --> D24 --> D25 --> D27
    D27 --> E28 --> E29 --> E30 --> E31 --> E32 --> E33 --> E34
    E34 --> P1 --> P2 --> P3 --> P4 --> P5
```

---

## 2. Stage 1 — Inquiry capture and allocation (company chart, with consent additions)

```mermaid
flowchart TD
    classDef sys fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef dist fill:#D5F0EC,stroke:#1B7A6B,color:#16233F
    classDef mgmt fill:#FDEFD3,stroke:#9A5B00,color:#16233F
    classDef bad fill:#FBE4E2,stroke:#B3261E,color:#16233F
    classDef add stroke:#BF9000,stroke-width:3px,stroke-dasharray:5 3
    classDef ok fill:#E3F3EA,stroke:#1B7A4B,color:#16233F

    S(["Inquiry source<br/>Website, Call, WhatsApp, Campaign, Referral"]):::sys
    X1["Record source and provenance<br/>capture notice version and consent<br/>purposes, channels, named recipients"]:::sys
    X2{"Consent present and DND scrub clear?"}:::sys
    X3["Block promotional outreach<br/>allow service reply only inside window<br/>log reason"]:::bad
    N1["1 Inquiry captured"]:::sys
    N2["2 Validate and de-duplicate<br/>mobile and e-mail valid<br/>check duplicate and existing customer"]:::sys
    X4{"Duplicate or existing owner?"}:::sys
    X5["Ownership lock decision<br/>manager override workflow"]:::mgmt
    N3["3 Capture details<br/>pincode, city, state, MW scale<br/>customer type, product interest<br/>segment"]:::sys
    N4["4 Territory and capability match<br/>territory, MW capacity<br/>product capability, distributor score<br/>vendor registration level and districts"]:::sys
    D1{"Distributor available and eligible?"}:::sys
    N6["6 Escalate to DSM or reassign territory"]:::bad
    N5["5 Auto-assign to distributor or DSM<br/>start acceptance clock"]:::dist
    N7["7 Lead acceptance by distributor"]:::dist
    D2{"Accepted within SLA?"}:::dist
    OK(["Lead accepted"]):::ok
    R1["Reminder 1"]:::bad
    R2["DSM alert"]:::bad
    R3["Auto reassignment to next best distributor"]:::bad
    SLA["Lead acceptance SLA [config]<br/>HOT 15 to 30 min<br/>WARM within 2 hrs<br/>COLD same working day"]:::sys

    S --> X1 --> X2
    X2 -- "No" --> X3 --> N1
    X2 -- "Yes" --> N1
    N1 --> N2 --> X4
    X4 -- "Yes" --> X5 --> N3
    X4 -- "No" --> N3
    N3 --> N4 --> D1
    D1 -- "YES" --> N5 --> N7 --> D2
    D1 -- "NO" --> N6
    N6 -. "reassign" .-> N5
    D2 -- "YES" --> OK
    D2 -- "NO" --> R1 --> R2 --> R3 -. "back to assignment" .-> N5
    SLA -.-> N7

    class X1,X2,X3,X4,X5 add
```

---

## 3. Stage 2 — Follow-up and lead classification

```mermaid
flowchart TD
    classDef sys fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef dist fill:#D5F0EC,stroke:#1B7A6B,color:#16233F
    classDef bad fill:#FBE4E2,stroke:#B3261E,color:#16233F
    classDef ok fill:#E3F3EA,stroke:#1B7A4B,color:#16233F
    classDef cold fill:#E4ECFA,stroke:#2A5DB0,color:#16233F
    classDef warm fill:#FDEFD3,stroke:#9A5B00,color:#16233F
    classDef hot fill:#FBE4E2,stroke:#B3261E,color:#16233F
    classDef add stroke:#BF9000,stroke-width:3px,stroke-dasharray:5 3

    N8["8 Initial customer contact<br/>call, WhatsApp, visit"]:::dist
    N9["9 Qualification call<br/>requirement, timeline<br/>budget, decision maker"]:::dist
    N10["10 Lead temperature"]:::sys
    COLD["COLD<br/>long-term or low urgency"]:::cold
    WARM["WARM<br/>1 to 3 months"]:::warm
    HOT["HOT<br/>0 to 30 days or immediate"]:::hot
    UP["Deadline uplift [config]<br/>raise one level if a compliance deadline<br/>is within 60 days<br/>CFA claim date, ALMM exemption date"]:::sys
    N11["11 Lead quality score<br/>requirement, MW, timeline<br/>budget, decision maker<br/>plus consent present, bill captured"]:::sys
    N12["12 CRM follow-up engine"]:::sys
    N13["13 Auto reminders and notifications"]:::sys
    MF["Mandatory fields on every save<br/>Last Action, Next Action<br/>Next Follow-up Date, Owner"]:::sys
    D1{"Next action completed on time?"}:::sys
    OK(["On track"]):::ok
    ESC["Escalation to DSM or Sales Manager"]:::bad
    FS["Follow-up SLA [config]<br/>HOT same day or daily<br/>WARM every 2 to 5 days<br/>COLD weekly or nurture"]:::sys
    CH{"Outbound channel allowed?"}:::sys
    CH1["WhatsApp free text only inside 24 h window<br/>otherwise approved template with consent"]:::sys
    CH2["SMS needs DLT template and header<br/>calls only on registered series, DND scrubbed<br/>90-day bar after opt-out"]:::sys

    N8 --> N9 --> N10
    N10 --> COLD
    N10 --> WARM
    N10 --> HOT
    COLD --> UP
    WARM --> UP
    HOT --> UP
    UP --> N11 --> N12 --> N13 --> D1
    D1 -- "YES" --> OK
    D1 -- "NO" --> ESC
    MF -.-> N12
    FS -.-> N13
    N13 --> CH
    CH -- "WhatsApp" --> CH1
    CH -- "SMS or call" --> CH2

    class UP,MF,CH,CH1,CH2 add
```

---

## 4. Stage 3 — Site visit and opportunity development

```mermaid
flowchart TD
    classDef sys fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef sales fill:#E8E1F7,stroke:#4A3AA7,color:#16233F
    classDef cust fill:#E3F3EA,stroke:#1B7A4B,color:#16233F
    classDef bad fill:#FBE4E2,stroke:#B3261E,color:#16233F
    classDef warn fill:#FDEFD3,stroke:#9A5B00,color:#16233F
    classDef add stroke:#BF9000,stroke-width:3px,stroke-dasharray:5 3

    SEG{"Segmentation fork"}:::sales
    P1["PMSG residential<br/>CFA, DCR, vendor of record"]:::sales
    P2["RWA or GHS<br/>common facilities, 500 kW cap"]:::sales
    P3["C and I captive<br/>behind the meter"]:::sales
    P4["Net-metered C and I"]:::sales
    P5["Open access<br/>surcharge and banking config"]:::sales
    P6["PM-KUSUM<br/>sanction date check"]:::sales
    P7["Government or bid"]:::sales

    N14["14 Customer site visit"]:::sales
    N15["15 Requirement capture form<br/>site, MW, load type, timeline, specs, documents<br/>plus consumer number, DISCOM, sanctioned load, phase<br/>bill upload, name match, roof title, pending dues<br/>existing solar kW, category"]:::sales
    NM{"Name on bill equals applicant<br/>and no pending dues?"}:::sys
    NMW["Warning G12<br/>fix before DISCOM filing"]:::warn
    FE{"System above 10 kW?"}:::sys
    FE1["No feasibility study needed"]:::sys
    FE2["Start 15-day feasibility clock [config]<br/>deemed feasible on DISCOM silence<br/>store submitted date and complete date"]:::sys
    N16["16 Product recommendation and brand USP<br/>quality, warranty, certifications<br/>service support, delivery reliability<br/>validated SKUs only"]:::sales
    CP["Live compliance panel<br/>ALMM, DCR, BIS, snapshot date"]:::sys
    N17["17 Technical discussion and solution fit"]:::sales
    N18["18 Rate negotiation with end customer"]:::cust
    Q{"Qualified project and real opportunity?<br/>requirement, timeline<br/>commercial potential confirmed"}:::sales
    N19["19 Convert to opportunity in CRM"]:::sales
    N20["20 Update opportunity<br/>probability, expected MW, revenue<br/>closing date, competitor<br/>expected commissioning date<br/>regulation version, exemption reliance"]:::sales
    NUR["Nurture or recycle lead<br/>re-engagement date"]:::bad
    WI["Work instruction<br/>do not convert unless requirement, timeline<br/>and commercial potential are confirmed<br/>also enforced by database trigger"]:::sys

    SEG --> P1
    SEG --> P2
    SEG --> P3
    SEG --> P4
    SEG --> P5
    SEG --> P6
    SEG --> P7
    P1 --> N14
    P2 --> N14
    P3 --> N14
    P4 --> N14
    P5 --> N14
    P6 --> N14
    P7 --> N14
    N14 --> N15 --> NM
    NM -- "No" --> NMW --> FE
    NM -- "Yes" --> FE
    FE -- "No" --> FE1 --> N16
    FE -- "Yes" --> FE2 --> N16
    N16 --> CP --> N17 --> N18 --> Q
    Q -- "YES" --> N19 --> N20
    Q -- "NO" --> NUR
    NUR -. "re-enter later" .-> N18
    WI -.-> Q

    class SEG,P1,P2,P3,P4,P5,P6,P7,NM,NMW,FE,FE1,FE2,CP add
```

---

## 5. Stage 4 — Quotation and approval

```mermaid
flowchart TD
    classDef sys fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef sales fill:#E8E1F7,stroke:#4A3AA7,color:#16233F
    classDef cust fill:#E3F3EA,stroke:#1B7A4B,color:#16233F
    classDef mgmt fill:#FDEFD3,stroke:#9A5B00,color:#16233F
    classDef bad fill:#FBE4E2,stroke:#B3261E,color:#16233F
    classDef add stroke:#BF9000,stroke-width:3px,stroke-dasharray:5 3

    N21["21 Prepare techno-commercial offer<br/>line HSN and GST with as-of date<br/>CFA, state share, loan share, consumer share<br/>validity date and change clause"]:::sales
    CE["Compliance engine evaluate quote<br/>gates G1 to G14"]:::sys
    HS{"Any hard stop?"}:::sys
    FIX["Fix SKU, dates or tax position<br/>or request compliance override"]:::bad
    N22["22 Internal price review<br/>margin and floor price check"]:::sales
    D1{"Special pricing or discount needed?"}:::sales
    N23["23 Approval matrix"]:::mgmt
    L1["Commercial lane<br/>DSM then Regional Head then Management"]:::mgmt
    L2["Compliance lane<br/>substitution, exemption reliance<br/>unverified rule dependency"]:::mgmt
    L3["Credit lane<br/>dealer limit, ageing, portal status"]:::mgmt
    N24["24 Send quotation to customer<br/>branded PDF with compliance summary"]:::sales
    N25["25 Customer discussion and negotiation"]:::cust
    D2{"Quotation accepted?"}:::sales
    N27["27 Commercial terms confirmed"]:::sales
    N26["26 Revise quote or follow-up<br/>new version, parent quote linked"]:::bad
    FU["Quote follow-up [config]<br/>Day 1, Day 3, Day 5, Day 7<br/>then escalation"]:::sys
    RQ["Re-quote engine<br/>flags open quotes when GST, duty<br/>ALMM list or exemption date changes"]:::sys

    N21 --> CE --> HS
    HS -- "Yes" --> FIX --> CE
    HS -- "No" --> N22 --> D1
    D1 -- "YES" --> N23
    N23 --> L1
    N23 --> L2
    N23 --> L3
    L1 --> N24
    L2 --> N24
    L3 --> N24
    D1 -- "NO" --> N24
    N24 --> N25 --> D2
    D2 -- "YES" --> N27
    D2 -- "NO" --> N26 --> N21
    FU -.-> N25
    RQ -. "requote required" .-> N21

    class CE,HS,FIX,L2,L3,RQ add
```

---

## 6. Stage 5 — PI, payment and sales order

```mermaid
flowchart TD
    classDef sys fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef cust fill:#E3F3EA,stroke:#1B7A4B,color:#16233F
    classDef mgmt fill:#FDEFD3,stroke:#9A5B00,color:#16233F
    classDef bad fill:#FBE4E2,stroke:#B3261E,color:#16233F
    classDef add stroke:#BF9000,stroke-width:3px,stroke-dasharray:5 3

    WI["Work instruction before PI<br/>legal name, billing and shipping address<br/>GST, product, quantity, price<br/>freight, payment terms confirmed"]:::sys
    CK{"Pre-PI checklist complete?"}:::sys
    CKF["Blocked until complete"]:::bad
    N28["28 Prepare proforma invoice<br/>funding split<br/>consumer share, loan share, subsidy receivable"]:::mgmt
    N29["29 PI approval and issue"]:::mgmt
    N30["30 Payment or credit verification<br/>advance received<br/>dealer limit, ageing buckets<br/>subsidy-linked receivables<br/>bank guarantee validity, portal status"]:::mgmt
    D1{"Advance received OR credit approved?"}:::mgmt
    HOLD["SO on hold<br/>reminder to customer<br/>escalation by clock engine"]:::bad
    N31["31 Customer PO or order confirmation"]:::cust
    G11{"Gate G11<br/>dealer over limit or portal deactivated?"}:::sys
    G11F["Hard stop on SO<br/>credit override needs Management approval"]:::bad
    N32["32 Create sales order<br/>in SAP or CRM"]:::sys
    N33["33 SO approval and stakeholder circulation"]:::mgmt
    N34["34 Hand over to dispatch planning"]:::mgmt

    WI -.-> CK
    CK -- "No" --> CKF --> CK
    CK -- "Yes" --> N28 --> N29 --> N30 --> D1
    D1 -- "NO" --> HOLD
    HOLD -. "payment or approval received" .-> D1
    D1 -- "YES" --> N31 --> G11
    G11 -- "Yes" --> G11F
    G11 -- "No" --> N32 --> N33 --> N34

    class CK,CKF,G11,G11F add
```

---

## 7. After dispatch — serial dispatch, installation, DISCOM, subsidy, loan, warranty (research addition)

The company chart ends at step 34. The research shows the order stays open for months afterwards.

```mermaid
flowchart TD
    classDef sys fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef dist fill:#D5F0EC,stroke:#1B7A6B,color:#16233F
    classDef cust fill:#E3F3EA,stroke:#1B7A4B,color:#16233F
    classDef mgmt fill:#FDEFD3,stroke:#9A5B00,color:#16233F
    classDef bad fill:#FBE4E2,stroke:#B3261E,color:#16233F
    classDef add stroke:#BF9000,stroke-width:3px,stroke-dasharray:5 3

    A["34 Hand over to dispatch planning"]:::mgmt
    B["Reserve serials by batch<br/>against SO lines"]:::sys
    C{"Dispatch compliance check<br/>serial snapshot compliant<br/>for the order segment?"}:::sys
    CF["Hard stop<br/>replace serial or approve override"]:::bad
    D["Dispatch note<br/>invoice chain: brand to distributor<br/>to dealer to site<br/>e-way bill and e-invoice status"]:::sys
    E["Installation<br/>vendor of record, geo-tagged photos<br/>installation certificate"]:::dist
    F["Start DISCOM commissioning clock [config]<br/>15 days from certificate submission"]:::sys
    G["DISCOM agreement, meter, commissioning<br/>Gujarat PMSG: regulation version by commissioning date"]:::dist
    H{"Within 15 days?"}:::sys
    HB["Deemed-clock breach logged<br/>escalate with evidence"]:::bad
    I["DISCOM inspection approval"]:::dist
    J["Subsidy claim readiness<br/>bank proof, photos, inspection approval, e-token"]:::mgmt
    K["Start CFA release clock [config]<br/>15 days from DISCOM approval<br/>legacy cohort deadline 30 Nov 2026 [config]"]:::sys
    L["Subsidy received<br/>into consumer or loan account"]:::mgmt
    M["Loan track<br/>bank, status, rejection code<br/>co-applicant, document checklist"]:::mgmt
    N["Close dealer receivable<br/>release subsidy-linked exposure"]:::mgmt
    O["Installed-base register<br/>warranty end, 5-year O and M clock"]:::dist
    P["Warranty or RMA ticket<br/>brand claim number, cost-bearer, TAT clock"]:::dist
    Q["Dealer complaint or MNRE SOP notice"]:::cust
    R["SOP tracker [config]<br/>reply 8 d, reminder 15 d, show-cause 15 d<br/>deactivation 1 month, appeal 30 d"]:::sys

    A --> B --> C
    C -- "Fail" --> CF --> B
    C -- "Pass" --> D --> E --> F --> G --> H
    H -- "No" --> HB --> I
    H -- "Yes" --> I
    I --> J --> K --> L --> N
    M -. "loan disbursal" .-> N
    N --> O --> P
    Q --> R
    R -. "deactivation feeds gate G11" .-> C

    class B,C,CF,D,E,F,G,H,HB,I,J,K,L,M,N,O,P,Q,R add
```

---

## 8. Compliance engine — gate evaluation logic

```mermaid
flowchart TD
    classDef sys fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef bad fill:#FBE4E2,stroke:#B3261E,stroke-width:2px,color:#16233F
    classDef warn fill:#FDEFD3,stroke:#9A5B00,stroke-width:2px,color:#16233F
    classDef ok fill:#E3F3EA,stroke:#1B7A4B,color:#16233F
    classDef info fill:#EEF1F8,stroke:#55627F,color:#16233F

    IN["Input<br/>quote or SO<br/>segment, expected commissioning date<br/>SKU list, dealer, customer"]:::sys
    RES["Resolve rules in force on reference date<br/>commissioning date for compliance<br/>quote date for pricing<br/>rule_config effective_from and status"]:::sys
    APP["Look up gate applicability<br/>gate by segment matrix"]:::sys
    LOOP["For each applicable gate<br/>G1 to G14"]:::sys
    R1{"Rule verified<br/>and active?"}:::sys
    VERD{"Condition violated?"}:::sys
    HARD["HARD STOP<br/>block send or dispatch<br/>override needs compliance lane approval<br/>with written reason"]:::bad
    SOFT["WARNING<br/>show rule, confidence and source<br/>needs acknowledgement"]:::warn
    ADV["ADVISORY ONLY<br/>rule unverified or conflicting<br/>never blocks until a compliance officer activates it"]:::info
    PASS["PASS"]:::ok
    SAVE["Store findings with rule ids used<br/>so the decision can be reproduced"]:::sys
    OUT{"Any hard stop left?"}:::sys
    GO(["Proceed"]):::ok
    NO(["Blocked"]):::bad

    IN --> RES --> APP --> LOOP --> R1
    R1 -- "No" --> ADV --> SAVE
    R1 -- "Yes" --> VERD
    VERD -- "No" --> PASS --> SAVE
    VERD -- "Yes, hard rule" --> HARD --> SAVE
    VERD -- "Yes, soft rule" --> SOFT --> SAVE
    SAVE --> OUT
    OUT -- "No" --> GO
    OUT -- "Yes" --> NO
```

### 8a. Gate catalogue

| Gate | Condition | Default severity when rule is verified and active | Basis confidence |
|---|---|---|---|
| G1 | Promotional message without consent, DND scrub, or within 90-day opt-out bar | Hard stop | High (TRAI Feb 2025 amendment) |
| G2 | PMSG or KUSUM quote with non-DCR module | Hard stop | High (MNRE guideline text) |
| G3 | ALMM-applicable project, module not on List-I (model level) | Hard stop | Medium-High |
| G4 | Subsidy or government project, cells not on List-II | Hard stop | Medium-High |
| G5 | Exemption-reliant job, commissioning after 31 Dec 2026 | Hard stop or override | High on date and scope |
| G6 | BIS licence missing, expired or model mismatch | Hard stop | Medium (standard number conflicting) |
| G7 | Inverter above 200 kW on self-certification after end date | Warning, then hard stop | Medium-High |
| G8 | Quote validity beyond price or duty horizon | Warning | Design rule |
| G9 | GST rate or HSN missing or tax position unapproved | Warning; hard stop for inverters while rule conflicting | Mixed |
| G10 | ALMM snapshot older than N days | Warning | Design rule |
| G11 | Dealer over credit limit or portal-deactivated | Hard stop on SO | Design rule plus MNRE SOP |
| G12 | Bill name mismatch or pending dues | Warning | Medium |
| G13 | PMSG system above 3 kW | Warning | High |
| G14 | Aadhaar number or image captured | Hard stop (policy) | Medium-Low (advisory withdrawn; safe default) |

---

## 9. Consent and messaging decision flow

```mermaid
flowchart TD
    classDef sys fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef bad fill:#FBE4E2,stroke:#B3261E,color:#16233F
    classDef ok fill:#E3F3EA,stroke:#1B7A4B,color:#16233F
    classDef warn fill:#FDEFD3,stroke:#9A5B00,color:#16233F

    START["Outbound message requested<br/>by user, follow-up engine or campaign"]:::sys
    T{"Message type?"}:::sys
    SV["Service or transactional"]:::sys
    PR["Promotional or marketing"]:::sys
    C1{"Consent record exists<br/>for this purpose and channel?"}:::sys
    C2{"Opt-out suppression active?<br/>90 days after opt-out"}:::sys
    C3{"DND scrub clear<br/>and not stale?"}:::sys
    CH{"Channel?"}:::sys
    W1{"WhatsApp 24 h window open?"}:::sys
    W2["Send free-form session message"]:::ok
    W3{"Approved template<br/>of correct category<br/>and opt-in present?"}:::sys
    W4["Send template<br/>category tag recorded for cost"]:::ok
    SM["SMS<br/>DLT template id and header required"]:::sys
    CL["Call<br/>registered promotional series only<br/>never from personal mobile"]:::sys
    BLK["BLOCK G1<br/>log reason and notify owner"]:::bad
    LOG["Write message_log<br/>consent id, template id, provider result"]:::sys
    OPT["Customer replies STOP or opt-out"]:::warn
    OP2["Set optout_suppress_until<br/>propagate to distributor and dealer<br/>one-click withdrawal logged"]:::bad

    START --> T
    T -- "Service" --> C1
    T -- "Promo" --> PR --> C1
    C1 -- "No" --> BLK
    C1 -- "Yes" --> C2
    C2 -- "Yes" --> BLK
    C2 -- "No" --> C3
    C3 -- "No" --> BLK
    C3 -- "Yes" --> CH
    CH -- "WhatsApp" --> W1
    W1 -- "Yes" --> W2 --> LOG
    W1 -- "No" --> W3
    W3 -- "Yes" --> W4 --> LOG
    W3 -- "No" --> BLK
    CH -- "SMS" --> SM --> LOG
    CH -- "Call" --> CL --> LOG
    OPT --> OP2
    SV -.-> LOG
```

---

## 10. Stage 6 — Escalation matrix and conversion gates (company chart)

```mermaid
flowchart LR
    classDef dist fill:#D5F0EC,stroke:#1B7A6B,color:#16233F
    classDef dsm fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef sm fill:#E8E1F7,stroke:#4A3AA7,color:#16233F
    classDef mg fill:#FDEFD3,stroke:#9A5B00,color:#16233F
    classDef trig fill:#FBE4E2,stroke:#B3261E,color:#16233F

    T1["Unaccepted lead"]:::trig
    T2["Overdue follow-up"]:::trig
    T3["Pending approval"]:::trig
    T4["Pending payment or credit"]:::trig
    T5["No customer response"]:::trig
    X1["Research additions<br/>Breach of DISCOM 15-day clock<br/>Legacy CFA claim near 30 Nov 2026<br/>Dealer deactivated or under SOP<br/>Stale non-List-II stock near 31 Dec 2026"]:::trig

    D["Distributor"]:::dist
    S["DSM"]:::dsm
    M["Sales Manager"]:::sm
    G["Management"]:::mg

    T1 --> D --> S --> M --> G
    T2 --> D
    T3 --> D
    T4 --> D
    T5 --> D
    X1 --> S
```

### 10a. Conversion gates and KPIs

```mermaid
flowchart LR
    classDef g fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef add stroke:#BF9000,stroke-width:3px,stroke-dasharray:5 3

    V["1 Valid Lead"]:::g -->|"Inquiry to Qualified Lead"| Q["2 Qualified Lead"]:::g
    Q -->|"Qualified Lead to Opportunity"| O["3 Opportunity"]:::g
    O -->|"Opportunity to Quotation"| QU["4 Quotation"]:::g
    QU -->|"Quotation to PI"| PI["5 PI"]:::g
    PI -->|"PI to Sales Order"| SO["6 Sales Order"]:::g
```

| KPI from company chart | Added by research |
|---|---|
| Inquiry → Qualified Lead | Split every conversion by **segment** |
| Qualified Lead → Opportunity | Survey → Quote; Loan approved ÷ Loan applied |
| Opportunity → Quotation | **Compliance-block rate** (quotes blocked by G2–G6 ÷ drafted) |
| Quotation → PI | **Consent coverage** (leads with valid consent before outbound) |
| PI → Sales Order | **DISCOM stage ageing** by DISCOM (median and 90th percentile) |
| First response SLA | Response inside the 24-hour WhatsApp window and 30 min for HOT |
| Follow-up compliance | **CFA pending value and age**; legacy claims at risk |
| — | **Dealer DSO, overdue %, subsidy-linked exposure vs limit** |
| — | Non-List-II stock exposure; RMA turnaround; re-quote rate |

---

## 11. State diagrams

### 11.1 Lead lifecycle

```mermaid
stateDiagram-v2
    [*] --> New: captured with consent record
    New --> Validated: mobile, e-mail, duplicate check passed
    New --> Duplicate: match found
    Duplicate --> Validated: manager override
    Duplicate --> Merged: merge into existing
    Validated --> Unassigned: no eligible distributor
    Validated --> Assigned: auto-assign
    Unassigned --> Assigned: DSM reassigns territory
    Assigned --> Accepted: distributor accepts within SLA
    Assigned --> Reassigned: SLA missed, auto reassignment
    Reassigned --> Assigned
    Assigned --> Rejected: distributor rejects
    Rejected --> Unassigned
    Accepted --> Contacted: step 8
    Contacted --> Qualified: step 9 and 11 complete
    Qualified --> SiteVisit: step 14
    SiteVisit --> Opportunity: three confirmations true
    SiteVisit --> Nurture: not qualified
    Nurture --> Contacted: re-engagement date reached
    Opportunity --> Lost: lost reason recorded
    Opportunity --> Won: sales order created
    Lost --> Nurture: optional recycle
    Merged --> [*]
    Won --> [*]
    Lost --> [*]
```

### 11.2 Quotation lifecycle

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> ComplianceCheck: evaluate
    ComplianceCheck --> Blocked: hard stop found
    Blocked --> Draft: fix or override approved
    ComplianceCheck --> PriceReview: no hard stop
    PriceReview --> PendingApproval: discount or compliance lane needed
    PriceReview --> Approved: no approval needed
    PendingApproval --> Approved: all lanes approve
    PendingApproval --> Rejected: any lane rejects
    Rejected --> Draft: revise
    Approved --> Sent: send to customer
    Sent --> Negotiation
    Negotiation --> Accepted: step 27
    Negotiation --> Revised: step 26 new version
    Revised --> Draft
    Sent --> RequoteRequired: rule or price changed
    Negotiation --> RequoteRequired: rule or price changed
    RequoteRequired --> Draft: owner re-quotes
    Sent --> Expired: validity date passed
    Expired --> Draft: renew
    Accepted --> [*]
```

### 11.3 Clock engine states (applies to every clock type)

```mermaid
stateDiagram-v2
    [*] --> Running: start trigger fires
    Running --> Warned: 70 percent of time used
    Warned --> Escalated1: 100 percent reached, owner to DSM
    Escalated1 --> Escalated2: still open, DSM to Sales Manager
    Escalated2 --> Escalated3: still open, to Management
    Running --> Met: completion event
    Warned --> Met: completion event
    Escalated1 --> Met: completion event
    Escalated2 --> Met: completion event
    Escalated3 --> Met: completion event
    Running --> Cancelled: entity cancelled
    Met --> [*]
    Cancelled --> [*]
    Escalated3 --> Breached: logged permanently
    Breached --> [*]
```

| Clock type | Start trigger | Length source |
|---|---|---|
| `lead_acceptance` | Lead assigned | `sla.lead_acceptance_*` |
| `followup` | Next follow-up date set | `sla.followup_days.*` |
| `quote_followup` | Quote sent | Day 1, 3, 5, 7 |
| `approval` | Approval lane opened | SLA setting |
| `discom_feasibility` | Application complete (above 10 kW) | 15 days **[config]** |
| `discom_commissioning` | Installation certificate submitted | 15 days **[config]** |
| `cfa_release` | DISCOM approval recorded | 15 days **[config]** |
| `legacy_cfa_claim_deadline` | Legacy cohort flag set | 30-Nov-2026 **[config, verify]** |
| `almm_exemption_commissioning` | Exemption-reliant job opened | 31-Dec-2026 |
| `sop_reply`, `sop_show_cause` | MNRE complaint notice logged | 8 and 15 days **[config]** |
| `grievance` | Grievance raised | 30 days |
| `loan_ageing` | Loan applied | Tracked from actual dates (no statutory SLA found) |
| `warranty_rma` | RMA ticket opened | Brand-specific; cost-bearer unknown |

---

## 12. Re-quote engine

```mermaid
flowchart TD
    classDef sys fill:#DCE9FB,stroke:#2A5DB0,color:#16233F
    classDef warn fill:#FDEFD3,stroke:#9A5B00,color:#16233F
    classDef bad fill:#FBE4E2,stroke:#B3261E,color:#16233F
    classDef ok fill:#E3F3EA,stroke:#1B7A4B,color:#16233F

    E1["rule_config changed<br/>GST, duty, ADD switch<br/>ALMM date, exemption date"]:::sys
    E2["sku_compliance changed<br/>List-I or List-II status<br/>DCR, BIS validity"]:::sys
    E3["sku_prices changed<br/>new price snapshot"]:::sys
    J["Nightly job and on-change hook"]:::sys
    F["Find open quotes that depend<br/>on the changed value<br/>via stored rule ids and SKU ids"]:::sys
    FL["Flag requote_required"]:::warn
    N["Notify quote owner and DSM"]:::warn
    X["Exposure report<br/>open quotes by SKU and value"]:::sys
    ST{"Stock-or-order flag?"}:::sys
    S1["Stock on hand<br/>check ALMM List-II status<br/>and exemption date"]:::sys
    S2["Order from supplier<br/>landed cost updated"]:::sys
    AG{"Old quote validity still open?"}:::sys
    HOLD["Do not honour old price<br/>unless Management approves"]:::bad
    RQ["Create new quote version"]:::ok

    E1 --> J
    E2 --> J
    E3 --> J
    J --> F --> FL --> N --> X --> ST
    ST -- "Stock" --> S1 --> AG
    ST -- "Order" --> S2 --> AG
    AG -- "Yes" --> HOLD --> RQ
    AG -- "No" --> RQ
```

---

## 13. Sequence — one order from lead to subsidy (who talks to whom)

```mermaid
sequenceDiagram
    autonumber
    actor CU as Customer
    participant CRM as CRM system
    participant DI as Distributor or DSM
    participant DL as Dealer or Installer
    participant CO as Compliance lane
    participant AC as Accounts credit lane
    participant DC as DISCOM
    participant BK as Bank
    participant PT as PMSG portal

    CU->>CRM: Enquiry with consent notice
    CRM->>CRM: Consent record, DND scrub, dedupe
    CRM->>DI: Auto-assign and start acceptance clock
    DI->>CRM: Accept within SLA
    DI->>CU: Initial contact and qualification call
    CRM->>CRM: Temperature and score
    DL->>CU: Site visit, bill and roof details
    DL->>CRM: Requirement form and survey photos
    CRM->>DC: Feasibility application if above 10 kW
    DC-->>CRM: Feasible or deemed feasible after 15 days
    DL->>CRM: Build quote with validated SKUs
    CRM->>CRM: Gate evaluation G1 to G14
    CRM->>CO: Compliance lane if flagged
    CO-->>CRM: Approve or reject with reason
    CRM->>AC: Credit lane for dealer limit and ageing
    AC-->>CRM: Approve or hold
    CRM->>CU: Send quotation
    CU-->>CRM: Accept
    DL->>BK: Loan application if financed
    BK-->>CRM: Approved, rejected with code, or pending
    CRM->>CU: Proforma invoice with funding split
    CU->>CRM: Advance payment or credit approved
    CRM->>CRM: Create sales order
    CRM->>DI: Dispatch with serial and compliance check
    DL->>CU: Install system
    DL->>CRM: Installation certificate and geo photos
    CRM->>DC: Commissioning request and 15-day clock
    DC-->>CRM: Meter and commissioning done
    CRM->>PT: Claim readiness checklist
    PT-->>CU: CFA to consumer or loan account
    CRM->>CRM: Close receivable and start 5-year O and M clock
```

---

## 14. Data model — core entities

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ PROFILES : has
    ORGANIZATIONS ||--o{ DISTRIBUTORS : has
    DISTRIBUTORS ||--o{ DEALERS : supplies
    DISTRIBUTORS ||--o{ VENDOR_REGISTRATIONS : holds
    DEALERS ||--o{ VENDOR_REGISTRATIONS : holds
    TERRITORIES }o--|| DISCOMS : served_by
    LEADS ||--o{ LEAD_CONSENTS : records
    LEADS ||--o{ LEAD_EVENTS : timeline
    LEADS ||--o{ FOLLOWUPS : schedules
    LEADS }o--|| DISTRIBUTORS : assigned_to
    LEADS ||--o| OPPORTUNITIES : converts_to
    CUSTOMERS ||--o{ SITES : owns
    SITES ||--o{ SITE_SURVEYS : surveyed_by
    OPPORTUNITIES }o--|| SITES : at
    OPPORTUNITIES ||--o{ QUOTATIONS : has
    QUOTATIONS ||--o{ QUOTATION_LINES : contains
    QUOTATION_LINES }o--|| SKUS : uses
    SKUS ||--|| SKU_COMPLIANCE : certified_by
    SKUS ||--o{ SKU_PRICES : priced_by
    QUOTATIONS ||--o{ APPROVALS : needs
    QUOTATIONS ||--o| PROFORMA_INVOICES : becomes
    PROFORMA_INVOICES ||--o{ PAYMENTS : receives
    PROFORMA_INVOICES ||--o| SALES_ORDERS : confirms
    SALES_ORDERS ||--o{ DISPATCHES : fulfilled_by
    DISPATCHES ||--o{ INVENTORY_SERIALS : ships
    SALES_ORDERS ||--o| INSTALLATIONS : installed_as
    INSTALLATIONS ||--o| DISCOM_APPLICATIONS : filed_with
    INSTALLATIONS ||--o| SUBSIDY_CLAIMS : claims
    OPPORTUNITIES ||--o| LOANS : financed_by
    INVENTORY_SERIALS ||--o{ WARRANTY_TICKETS : claims
    DEALERS ||--o{ DEALER_RECEIVABLES : owes
    RULE_CONFIG ||--o{ CLOCKS : sets_length
    CLOCKS }o--|| LEADS : times
    ORGANIZATIONS ||--o{ RULE_CONFIG : governs
    ORGANIZATIONS ||--o{ AUDIT_LOG : records
```

---

## 15. Compliance calendar (confidence as per the report)

```mermaid
gantt
    title Compliance cliffs from 26-Oct-2026
    dateFormat  YYYY-MM-DD
    axisFormat  %d-%b-%y
    section Near term
    DPDP Consent Manager registration   :milestone, m1, 2026-11-13, 0d
    CFA claim deadline legacy cohort (verify OM) :milestone, m2, 2026-11-30, 0d
    ALMM List-II exemption ends (commissioning) :milestone, m3, 2026-12-31, 0d
    BIS inverter self-cert above 200 kW ends unless extended :milestone, m4, 2026-12-31, 0d
    WhatsApp India INR billing migration :milestone, m5, 2026-12-31, 0d
    section 2027 onward
    PMSG programme end and KUSUM A and C commissioning :milestone, m6, 2027-03-31, 0d
    DPDP core duties start :milestone, m7, 2027-05-13, 0d
    ALMM List-III wafers and ingots :milestone, m8, 2028-06-01, 0d
```

| Date | Event | Days from 26-Oct-2026 | Confidence |
|---|---|---|---|
| 13-Nov-2026 | DPDP Consent Manager registration | 18 | High on date |
| 30-Nov-2026 | CFA claim deadline, legacy cohort | 35 | Medium (OM not read) |
| 31-Dec-2026 | ALMM List-II exemption for net-metering and open-access commissioning ends | 66 | High on date and scope |
| 31-Dec-2026 | BIS self-certification for inverters above 200 kW ends unless extended | 66 | Medium-High |
| 31-Dec-2026 | WhatsApp India INR billing migration deadline | 66 | High |
| 31-Mar-2027 | PMSG programme end; KUSUM Components A and C commissioning | 156 | Medium |
| 13-May-2027 | DPDP core duties (a 12-month compression was proposed, not notified as of 08-Oct-2026) | 199 | High on date as notified |
| 01-Jun-2028 | ALMM List-III | 583 | Medium-High |

---

## 16. Verify before relying — items that change what a diagram shows

| Diagram element | Open question | Where to check |
|---|---|---|
| Legacy CFA deadline (Sections 7, 11.3, 15) | 30-Nov-2026 OM text and scope not read | MNRE OM dated 31-Aug-2026; pmsuryaghar.gov.in |
| Gate G3/G4 and bid-date carve-out | 09-Dec-2024 vs 31-Aug-2025 conflict | MNRE ALMM OMs and FAQ |
| Gate G6 | BIS module standard: IS 14286 vs IS 14086 | BIS / S.O. 492(E) schedule |
| Gate G9 and quote tax lines | Inverter GST 5% vs 18%; 70:30 split unverified | CBIC notifications; CA review |
| Re-quote engine ADD switch | ADD on Chinese cells and modules recommended; notification unconfirmed | CBIC customs notifications |
| Gate G2 | A vendor guide claims PMSG needs no DCR; MNRE text and press say it does | MNRE guideline clause |
| Section 7 clocks | DISCOM stage SLAs: only the 15-day rules were found; no statutory SLA for other stages | Rights of Consumers Rules; DISCOM circulars |
| Section 7 Gujarat branch | Gujarat state subsidy and net-metering specifics from a summary and a vendor blog | GR, GERC gazette, GEDA |
| Sections 2, 3, 9 | TRAI series (1600 vs 160) and header suffix (-P vs -F); Third Amendment status | TRAI gazette; DoT |
| Section 9 | DPDP deemed consent, grievance timelines, exemptions not verified | DPDP Rules gazette |
| Distributor margins, credit days, conversion rates | **No reliable data** — vendor hypotheses | Interviews with 5–10 Gujarat distributors |

---

## 17. Mapping — company chart step to diagram and to build prompt

| Chart step | Name | Diagram section | Notes |
|---|---|---|---|
| 1 | Inquiry captured | 2 | Consent and provenance added |
| 2 | Validate and de-duplicate | 2 | Ownership lock added |
| 3 | Capture details | 2 | Segment required |
| 4 | Territory and capability match | 2 | Vendor registration level and districts added |
| 5 | Auto-assign to distributor / DSM | 2 | Acceptance clock |
| 6 | Escalate to DSM / reassign | 2 | |
| 7 | Lead acceptance by distributor | 2 | SLA 15–30 min / 2 h / same day |
| 8 | Initial customer contact | 3 | Channel rules added |
| 9 | Qualification call | 3 | |
| 10 | Lead temperature | 3 | Deadline uplift added |
| 11 | Lead quality score | 3 | Consent and bill captured added |
| 12 | CRM follow-up engine | 3 | Mandatory fields enforced |
| 13 | Auto reminders and notifications | 3 | WhatsApp window logic |
| 14 | Customer site visit | 4 | Geo-tagged photos |
| 15 | Requirement capture form | 4 | DISCOM and bill fields added |
| 16 | Product recommendation and brand USP | 4 | Validated SKUs only |
| 17 | Technical discussion and solution fit | 4 | |
| 18 | Rate negotiation with end customer | 4 | |
| 19 | Convert to opportunity | 4 | DB trigger on three confirmations |
| 20 | Update opportunity | 4 | Commissioning date and regulation version added |
| 21 | Prepare techno-commercial offer | 5 | Tax, CFA split, validity |
| 22 | Internal price review | 5 | Floor price |
| 23 | Approval matrix | 5 | Three lanes |
| 24 | Send quotation to customer | 5 | |
| 25 | Customer discussion / negotiation | 5 | |
| 26 | Revise quote / follow-up | 5 | Versioning |
| 27 | Commercial terms confirmed | 5 | |
| 28 | Prepare proforma invoice | 6 | Funding split |
| 29 | PI approval and issue | 6 | |
| 30 | Payment / credit verification | 6 | Dealer exposure added |
| 31 | Customer PO / order confirmation | 6 | |
| 32 | Create sales order (SAP / CRM) | 6 | Gate G11 |
| 33 | SO approval and circulation | 6 | |
| 34 | Hand over to dispatch planning | 6, 7 | Flow continues in Section 7 |
