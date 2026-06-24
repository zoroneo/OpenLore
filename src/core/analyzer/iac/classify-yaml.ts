/**
 * Content-based disambiguation for ambiguous IaC file extensions (spec-07).
 *
 * `.yaml`/`.yml`/`.json` are used by Kubernetes, CloudFormation, Helm, Ansible,
 * and plain config alike. `detectLanguage` can only see the extension, so it
 * routes these through `classifyYaml`, a small pure function that inspects path
 * + content. When unsure, return `null` (→ `unknown`): never force a
 * classification onto generic YAML (CI configs, docker-compose, app config).
 */

import type { IacLanguage } from './types.js';

/**
 * Classify an ambiguous `.yaml`/`.yml`/`.json` file by its path + content.
 * Returns the IaC language, or `null` when the file is not recognizably IaC.
 *
 * Note: Helm chart membership that depends on an ancestor `Chart.yaml` is
 * resolved by the caller (it needs the file set); here we only catch the
 * unambiguous Helm signal of a `{{ … }}` template under a `templates/` dir.
 */
export function classifyYaml(path: string, content: string): IacLanguage | null {
  const posix = path.replace(/\\/g, '/');
  const lower = posix.toLowerCase();
  const fileName = posix.split('/').pop() ?? '';

  // Helm chart metadata files (unambiguous by name).
  if (fileName === 'Chart.yaml' || fileName === 'Chart.yml') return 'Helm';

  // docker-compose — by conventional filename (docker-compose*.yml, compose*.yml),
  // corroborated by a top-level `services:` key so a stray same-named file is not
  // misclassified (add-docker-container-graph).
  if (/^(docker-compose|compose)(\.[^/]+)?\.ya?ml$/.test(fileName) && /(^|\n)services\s*:/.test(content)) {
    return 'Docker Compose';
  }

  // Helm template: a Go-template expression inside a templates/ directory.
  const inTemplatesDir = /(^|\/)templates\//.test(posix);
  if (inTemplatesDir && /\{\{[-\s]/.test(content)) return 'Helm';

  // CloudFormation / SAM — explicit format markers.
  if (
    /(^|\n)\s*AWSTemplateFormatVersion\s*:/.test(content) ||
    /(^|\n)\s*Transform\s*:\s*['"]?AWS::Serverless/.test(content) ||
    isCloudFormationResources(content)
  ) {
    return 'CloudFormation';
  }

  // Kubernetes — apiVersion + kind at (near) the top level of a document.
  if (isKubernetesManifest(content)) return 'Kubernetes';

  // Ansible — playbook (top-level hosts/tasks/roles) or role-tree location.
  if (isAnsiblePath(lower) || isAnsiblePlaybook(content)) return 'Ansible';

  return null;
}

/** `Resources:` block whose entries carry `Type: AWS::…` (CFN without the header). */
function isCloudFormationResources(content: string): boolean {
  if (!/(^|\n)Resources\s*:/.test(content)) return false;
  return /(^|\n)\s+Type\s*:\s*['"]?(AWS|Alexa|Custom)::/.test(content);
}

/** Any YAML document declaring both `apiVersion:` and `kind:`. */
function isKubernetesManifest(content: string): boolean {
  // Inspect each `---`-separated document; K8s objects pair apiVersion + kind.
  for (const doc of content.split(/^---\s*$/m)) {
    const hasApiVersion = /(^|\n)\s*apiVersion\s*:/.test(doc);
    const hasKind = /(^|\n)\s*kind\s*:/.test(doc);
    if (hasApiVersion && hasKind) return true;
  }
  return false;
}

/** Located under an Ansible role tree (`roles/<name>/{tasks,handlers,...}/`). */
function isAnsiblePath(lowerPath: string): boolean {
  return /(^|\/)roles\/[^/]+\/(tasks|handlers|defaults|vars|meta)\//.test(lowerPath);
}

/** Top-level playbook markers: a list of plays with hosts/tasks/roles. */
function isAnsiblePlaybook(content: string): boolean {
  // Playbooks are a top-level list; plays declare `hosts:` and usually
  // `tasks:`/`roles:`. Match a `- hosts:` item or a top-level tasks/handlers file.
  if (/(^|\n)\s*-\s+hosts\s*:/.test(content)) return true;
  // A list whose play items carry a `hosts:` key (possibly after `- name:`).
  if (/(^|\n)\s*-\s/.test(content) && /(^|\n)\s+hosts\s*:/.test(content)) return true;
  // tasks/handlers main.yml in a role: a top-level list whose items have `name:`
  // plus a module key — too weak alone, so require an Ansible-specific keyword.
  if (/(^|\n)\s*-\s+(name|block|include_tasks|import_tasks|ansible\.builtin)\s*:/.test(content)) {
    return /(^|\n)\s*(notify|register|when|loop|with_items|become|ansible\.builtin\.)\s*:/.test(content)
      || /(^|\n)\s*-\s+(include_tasks|import_tasks|ansible\.builtin\.)/.test(content);
  }
  return false;
}
