import {
  ASTNode,
  DefinitionNode,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  SelectionNode,
  visit,
} from 'graphql';
import { mergeWith } from 'lodash';
import flatten from 'lodash/flatten';

import { Entities, NodeWithDirectives } from './types';

function _isNodeWithDirectives(node?: any): node is NodeWithDirectives {
  return node != null && node.directives != null;
}

export function getDirectiveType(directiveNode: any): string {
  const typeName = directiveNode?.arguments?.[0]?.value?.value;

  if (typeName == null) {
    throw new Error('Invalid @computed directive found. No type specified');
  }

  return typeName;
}

export function nodeHasComputedDirectives(node?: ASTNode): boolean {
  if (!_isNodeWithDirectives(node)) {
    return false;
  }

  return node.directives != null && node.directives.some((d) => d.name.value === 'computed');
}

// Return type is "any" because that's the return type of the visit() function from graphql
export function replaceDirectivesByFragments(
  query: DefinitionNode | DocumentNode | undefined,
  entities: Entities,
): any {
  if (query == null) {
    return null;
  }

  const replaceDirectiveByFragment = (node: FieldNode): FragmentDefinitionNode => {
    const computedDirective = node.directives?.find((d) => d.name.value === 'computed');
    const directiveType = getDirectiveType(computedDirective);
    const entityType = entities[directiveType];

    if (entityType == null) {
      throw new Error(`No entity found for type "${directiveType}"`);
    }

    const fieldName = node.name.value;
    const entityField = entityType.fields[fieldName];

    if (entityField == null) {
      throw new Error(
        `No resolver found for @computed directive "${fieldName}" in type "${directiveType}"`,
      );
    }

    // Replace directive node by fragment
    const fragment = entityField.dependencies?.definitions[0] as FragmentDefinitionNode;
    return replaceDirectivesByFragments(fragment, entities);
  };

  const firstPass = visit(query, {
    Field(node) {
      if (!nodeHasComputedDirectives(node)) {
        return undefined; // Don't do anything with this node
      }
      const fragment = replaceDirectiveByFragment(node);
      return fragment.selectionSet.selections;
    },
  });

  return visit(firstPass, {
    SelectionSet(node) {
      node.selections = flatten(node.selections)

      const fields = node.selections
        .filter(
          (selection): selection is FieldNode =>
            selection.kind === 'Field',
        )
        .reduce((acc, field) => {
          const name = field.alias?.value || field.name.value;
          acc[name] = [...(acc[name] || []), field];
          return acc;
        }, {} as Record<string, FieldNode[]>);

      node.selections = [
        ...node.selections.filter((selection): selection is SelectionNode =>
          selection.kind !== 'Field',
        ),
        ...Object.values(fields).map((fields) =>
          fields.reduce((acc, field) => {
            return mergeWith(acc, field, (objValue, srcValue) => {
              if (Array.isArray(objValue)) {
                return objValue.concat(srcValue);
              }
            });
          }, {} as FieldNode),
        ),
      ];

      return node;
    },
    Directive(node) {
      if (node.name.value === 'computed') {
        return null; // Remove @computed directives from the query
      }
    },
  });
}

// Return type is "any" because that's the return type of the visit() function from graphql
export function addFragmentsFromDirectives(
  query: DefinitionNode | DocumentNode | undefined,
  entities: Entities,
): any {
  if (query == null) {
    return null;
  }

  const addFragmentToNode = (node: FieldNode): FragmentDefinitionNode => {
    const computedDirective = node.directives?.find((d) => d.name.value === 'computed');
    const directiveType = getDirectiveType(computedDirective);
    const entityType = entities[directiveType];

    if (entityType == null) {
      throw new Error(`No entity found for type "${directiveType}"`);
    }

    const fieldName = node.name.value;
    const entityField = entityType.fields[fieldName];

    if (entityField == null) {
      throw new Error(
        `No resolver found for @computed directive "${fieldName}" in type "${directiveType}"`,
      );
    }
    const fragment = entityField.dependencies?.definitions[0] as FragmentDefinitionNode;
    return addFragmentsFromDirectives(fragment, entities);
  };

  const firstPass = visit(query, {
    Field(node) {
      if (!nodeHasComputedDirectives(node)) {
        return undefined; // Don't do anything with this node
      }
      const fragment = addFragmentToNode(node);
      return [node, ...fragment.selectionSet.selections];
    },
  });

  // Flatten nodes that instead of being a single node, are an array
  // of Field and InlineFragment from the firstPass
  return visit(firstPass, {
    SelectionSet(node) {
      node.selections = flatten(node.selections);
      return node;
    },
  });
}
