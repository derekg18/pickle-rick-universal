import * as fs from 'fs';
import * as path from 'path';
const TEAM_FLOW_DIR = 'team-flow';
export const TEAM_FLOW_CLASSIFIER_ARTIFACT = path.join(TEAM_FLOW_DIR, 'security_classifier.json');
const FULL_PHASES = [
    {
        id: 'product_intake',
        requiredInputs: ['prd_refined.md'],
        requiredOutputs: [path.join(TEAM_FLOW_DIR, 'product_brief.md')],
    },
    {
        id: 'ready_gate',
        requiredInputs: [path.join(TEAM_FLOW_DIR, 'product_brief.md')],
        requiredOutputs: [
            path.join(TEAM_FLOW_DIR, 'ready_gate_report.json'),
            path.join(TEAM_FLOW_DIR, 'ready_gate_report.md'),
        ],
    },
    {
        id: 'architecture_review',
        requiredInputs: [
            path.join(TEAM_FLOW_DIR, 'ready_gate_report.json'),
            path.join(TEAM_FLOW_DIR, 'ready_gate_report.md'),
        ],
        requiredOutputs: [path.join(TEAM_FLOW_DIR, 'architecture_review.md')],
    },
    {
        id: 'implementation',
        requiredInputs: [path.join(TEAM_FLOW_DIR, 'architecture_review.md')],
        requiredOutputs: [path.join(TEAM_FLOW_DIR, 'implementation_log.md')],
    },
    {
        id: 'test_engineering',
        requiredInputs: [path.join(TEAM_FLOW_DIR, 'implementation_log.md')],
        requiredOutputs: [path.join(TEAM_FLOW_DIR, 'test_plan.md')],
    },
    {
        id: 'ci_simulation',
        requiredInputs: [path.join(TEAM_FLOW_DIR, 'test_plan.md')],
        requiredOutputs: [
            path.join(TEAM_FLOW_DIR, 'ci_report.json'),
            path.join(TEAM_FLOW_DIR, 'ci_report.md'),
        ],
    },
    {
        id: 'code_review',
        requiredInputs: [
            path.join(TEAM_FLOW_DIR, 'ci_report.json'),
            path.join(TEAM_FLOW_DIR, 'ci_report.md'),
        ],
        requiredOutputs: [
            path.join(TEAM_FLOW_DIR, 'review_comments.json'),
            path.join(TEAM_FLOW_DIR, 'review_comments.md'),
        ],
    },
    {
        id: 'security_risk_review',
        requiredInputs: [
            path.join(TEAM_FLOW_DIR, 'review_comments.json'),
            path.join(TEAM_FLOW_DIR, 'review_comments.md'),
        ],
        requiredOutputs: [path.join(TEAM_FLOW_DIR, 'security_risk_report.md')],
        canSkip: 'deterministic_no_sensitive_paths',
    },
    {
        id: 'qa_acceptance',
        requiredInputs: [path.join(TEAM_FLOW_DIR, 'security_risk_report.md')],
        requiredOutputs: [path.join(TEAM_FLOW_DIR, 'qa_acceptance.md')],
    },
    {
        id: 'release_management',
        requiredInputs: [path.join(TEAM_FLOW_DIR, 'qa_acceptance.md')],
        requiredOutputs: [
            path.join(TEAM_FLOW_DIR, 'release_notes.md'),
            path.join(TEAM_FLOW_DIR, 'rollback_plan.md'),
        ],
    },
    {
        id: 'retrospective',
        requiredInputs: [
            path.join(TEAM_FLOW_DIR, 'release_notes.md'),
            path.join(TEAM_FLOW_DIR, 'rollback_plan.md'),
        ],
        requiredOutputs: [path.join(TEAM_FLOW_DIR, 'retro.md')],
    },
];
function unique(values) {
    return [...new Set(values)];
}
function artifactExists(sessionRoot, relativePath) {
    return fs.existsSync(path.join(sessionRoot, relativePath));
}
function readJsonObject(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
export function hasDeterministicNoSensitivePathsClassifier(sessionRoot) {
    const classifier = readJsonObject(path.join(sessionRoot, TEAM_FLOW_CLASSIFIER_ARTIFACT));
    if (!classifier)
        return false;
    return classifier.classifier === 'deterministic_no_sensitive_paths'
        && classifier.sensitivePathChanges === false;
}
export function resolveTeamFlowProfile(request) {
    const phases = request.mode === 'full' ? FULL_PHASES.map((phase) => ({ ...phase })) : [];
    const artifacts = phases.flatMap((phase) => phase.requiredOutputs.map((artifactPath) => ({
        phaseId: phase.id,
        path: artifactPath,
        required: true,
    })));
    const gates = phases.map((phase) => ({
        phaseId: phase.id,
        requiredArtifacts: [...phase.requiredInputs],
        remediation: `Create missing artifact(s) for ${phase.id} under ${TEAM_FLOW_DIR}/ before continuing.`,
    }));
    return {
        mode: request.mode,
        phases,
        artifacts,
        gates,
        artifactDir: path.join(request.sessionRoot, TEAM_FLOW_DIR),
        backend: request.backend,
        workingDir: request.workingDir,
    };
}
export function evaluateTeamFlowGate(profile, phaseId, sessionRoot) {
    const phase = profile.phases.find((candidate) => candidate.id === phaseId);
    if (!phase) {
        return {
            phaseId,
            status: 'fail',
            missingArtifacts: [],
            remediation: `Unknown team-flow phase: ${phaseId}`,
        };
    }
    const requiredInputs = phase.id === 'qa_acceptance'
        && hasDeterministicNoSensitivePathsClassifier(sessionRoot)
        && !artifactExists(sessionRoot, path.join(TEAM_FLOW_DIR, 'security_risk_report.md'))
        ? [
            path.join(TEAM_FLOW_DIR, 'review_comments.json'),
            path.join(TEAM_FLOW_DIR, 'review_comments.md'),
        ]
        : phase.requiredInputs;
    const missingArtifacts = unique(requiredInputs.filter((artifactPath) => !artifactExists(sessionRoot, artifactPath)));
    if (phase.canSkip === 'deterministic_no_sensitive_paths'
        && missingArtifacts.length === 0
        && !artifactExists(sessionRoot, path.join(TEAM_FLOW_DIR, 'security_risk_report.md'))
        && hasDeterministicNoSensitivePathsClassifier(sessionRoot)) {
        return { phaseId, status: 'skipped', missingArtifacts: [], remediation: null };
    }
    if (missingArtifacts.length > 0) {
        return {
            phaseId,
            status: 'fail',
            missingArtifacts,
            remediation: `Create missing artifact(s): ${missingArtifacts.join(', ')}`,
        };
    }
    return { phaseId, status: 'pass', missingArtifacts: [], remediation: null };
}
