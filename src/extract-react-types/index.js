// @noflow

/* ::
export type * from './kinds'
import * as K from './kinds'
*/

const nodePath = require('path');
const createBabelFile = require('babel-file');
const {
  loadFileSync,
  resolveImportFilePathSync
} = require('babel-file-loader');
const { isFlowIdentifier } = require('babel-flow-identifiers');
const { getTypeBinding } = require('babel-type-scopes');
const { getIdentifierKind } = require('babel-identifiers');
const { isReactComponentClass } = require('babel-react-components');
const createBabylonOptions = require('babylon-options');
const t = require('@babel/types');
const { normalizeComment } = require('babel-normalize-comments');
const { sync: resolveSync } = require('resolve');

const matchExported = require('./matchExported');
const { isReactAnnotated, isExcludePropAnnotated } = require('../isAnnotated');

const converters = {};

const getPropFromObject = (props, property) => {
  let prop;

  if (!props.members) {
    throw new Error(
      `Attempted to get property from non-object kind: ${
        props.kind
      }. Full object: ${JSON.stringify(props)}`
    );
  }

  props.members.forEach(p => {
    if (p.kind === 'spread') {
      const p2 = getPropFromObject(p.value.value, property);
      if (p2) prop = p2;
      // The kind of the object member must be the same as the kind of the property
    } else if (property.key.kind === 'id' && p.key.name === property.key.name) {
      prop = p;
    } else if (
      property.key.kind === 'string' &&
      p.key.value === property.key.value
    ) {
      prop = p;
    }
  });

  return prop;
};

const resolveFromGeneric = type => {
  if (type.kind !== 'generic') return type;
  return resolveFromGeneric(type.value);
};

const getProp = (props, property) => {
  let prop;
  if (props.kind === 'intersection') {
    props.types.forEach(pr => {
      prop = getProp(resolveFromGeneric(pr), property) || prop;
    });
  } else if (props.kind === 'object') {
    prop = getPropFromObject(props, property);
  }

  return prop;
};

const isVariableOfMembers = defaultProps => {
  const defaultPropsIsVar =
    defaultProps &&
    defaultProps.value &&
    defaultProps.value.kind === 'variable';
  if (!defaultPropsIsVar) {
    return false;
  }
  const declarations = defaultProps.value.declarations;

  const lastDeclarationIsObject =
    declarations[declarations.length - 1].value.kind === 'object';

  if (lastDeclarationIsObject) {
    return true;
  }
  return false;
};

const getDefaultPropsForFunction = (path, context) => {
  let defaultProps = [];
  const functionName = path.node.declarations[0].id.name;

  const esPath = path.parentPath.get('body').find(p => {
    if (p.type !== 'ExpressionStatement') return false;

    const expression = p.get('expression');
    if (!expression || expression.node.type !== 'AssignmentExpression')
      return false;

    const left = expression.get('left');
    if (!left) return false;

    const property = left.get('property');
    const object = left.get('object');

    if (!property || !object) return false;

    return (
      property.node.name === 'defaultProps' && object.node.name === functionName
    );
  });

  if (!esPath) return [];
  const propertiesPath = esPath.get('expression').get('right');

  defaultProps = convert(propertiesPath, { ...context, mode: 'value' });

  if (defaultProps && defaultProps.kind === 'object') {
    return defaultProps.members;
  }
  return [];
};

const getDefaultProps = (path, context) => {
  let defaultProps = null;

  path
    .get('body')
    .get('body')
    .find(p => {
      if (
        p.isClassProperty() &&
        p.get('key').isIdentifier({ name: 'defaultProps' })
      ) {
        defaultProps = convert(p, { ...context, mode: 'value' });
      }
    });

  const defaultPropsArr = [];

  if (!defaultProps) {
    return [];
  }
  if (
    defaultProps &&
    defaultProps.value &&
    defaultProps.value.kind === 'object'
  ) {
    return defaultProps.value.members;
  }
  if (isVariableOfMembers(defaultProps)) {
    return defaultProps.value.declarations[
      defaultProps.value.declarations.length - 1
    ].value.members;
  }
  throw new Error(`Could not resolve default Props, ${defaultProps}`);
};

converters.Program = (path, context) /* : K.Program */ => {
  const result = {};
  result.kind = 'program';
  result.classes = [];
  result.functions = [];

  path.traverse({
    ClassDeclaration(cd) {
      if (isReactAnnotated(cd)) {
        const classProperties = convertReactComponentClass(cd, context);
        result.classes.push(classProperties);
      }
    }
  });

  path.traverse({
    VariableDeclaration(vd) {
      if (isReactAnnotated(vd)) {
        const functionProperties = convertReactComponentFunction(vd, context);
        result.functions.push(functionProperties);
      }
    }
  });

  return result;
};

function convertReactComponentFunction(path, context) {
  if (!functionHasParameterTypeAnnotations(path)) return null;

  // get props parameter value
  const params = path
    .get('declarations')[0]
    .get('init')
    .get('params');

  const props = params[0].get('typeAnnotation').get('typeAnnotation');
  const classProperties = convert(props, { ...context, mode: 'type' });
  classProperties.name = convert(path.get('id'), {
    ...context,
    mode: 'value'
  });

  const defaultProps = getDefaultPropsForFunction(path, context);
  defaultProps.forEach(property => {
    const ungeneric = resolveFromGeneric(classProperties);
    const prop = getProp(ungeneric, property);
    if (!prop) {
      throw new Error(
        JSON.stringify(
          `could not find property to go with default of ${
            property.key.value ? property.key.value : property.key.name
          } in ${classProperties.name}`
        )
      );
    }
    prop.default = property.value;
  });

  return classProperties;
}

function functionHasParameterTypeAnnotations(path) {
  const declarations = path.get('declarations');
  if (
    declarations === undefined ||
    declarations.length === undefined ||
    declarations.length === 0
  )
    return false;

  const id = declarations[0].get('id');
  if (id === undefined) return false;

  const name = id.get('name');
  if (name.node === undefined) return false;

  const init = declarations[0].get('init');
  if (init === undefined) return false;

  const params = init.get('params');

  if (
    params === undefined ||
    params.length === undefined ||
    params.length === 0
  )
    return false;

  const ta = params[0].get('typeAnnotation');
  if (ta === undefined) return false;

  return ta.isTypeAnnotation();
}

function classHasSuperTypeParameters(path) {
  return (
    path.get('superTypeParameters').isTypeParameterInstantiation() &&
    path.get('superTypeParameters').get('params').length > 0
  );
}

function convertReactComponentClass(path, context) {
  if (!classHasSuperTypeParameters(path)) return;
  let params = path.get('superTypeParameters');

  params = params.get('params');

  const props = params[0];
  const defaultProps = getDefaultProps(path, context);

  const classProperties = convert(props, { ...context, mode: 'type' });
  classProperties.name = convert(path.get('id'), {
    ...context,
    mode: 'value'
  });

  defaultProps.forEach(property => {
    const ungeneric = resolveFromGeneric(classProperties);
    const prop = getProp(ungeneric, property);
    if (!prop) {
      throw new Error(
        JSON.stringify(
          `could not find property to go with default of ${
            property.key.value ? property.key.value : property.key.name
          } in ${classProperties.name}`
        )
      );
    }
    prop.default = property.value;
  });

  return classProperties;
}

// ############################################################################## Convertors

converters.TaggedTemplateExpression = (
  path,
  context
) /* : K.TemplateExpression */ => ({
  kind: 'templateExpression',
  tag: convert(path.get('tag'), context)
});

converters.TemplateElement = (path, context) /* : K.TemplateElement */ => ({
  kind: 'templateElement',
  value: path.node.value
});

converters.TemplateLiteral = (path, context) /* : K.TemplateLiteral */ =>
  // hard challenge, we need to know the combined ordering of expressions and quasis
  ({
    kind: 'templateLiteral',
    expressions: path.get('expressions').map(e => convert(e, context)),
    quasis: path.get('quasis').map(q => convert(q, context))
  });

converters.RestElement = (path, context) /* : K.Rest */ => ({
  kind: 'rest',
  argument: convert(path.get('argument'), context)
});

converters.AssignmentPattern = (path, context) /* : K.AssignmentPattern */ => ({
  kind: 'assignmentPattern',
  left: convert(path.get('left'), context),
  right: convert(path.get('right'), context)
});

converters.ObjectPattern = (path, context) /* : K.ObjectPattern */ => {
  const members = [];

  for (const property of path.get('properties')) {
    members.push(convert(property, context));
  }

  return {
    kind: 'objectPattern',
    members
  };
};

converters.ClassDeclaration = (path, context) /* : K.ClassKind */ => {
  if (!isReactComponentClass(path)) {
    return {
      kind: 'class',
      name: convert(path.get('id'), context)
    };
  }
  return convertReactComponentClass(path, context);
};

converters.SpreadElement = (path, context) /* : K.Spread */ => ({
  kind: 'spread',
  value: convert(path.get('argument'), context)
});

// This has been renamed to SpreadElement in babel 7. Added here for backwards
// compatibility in other projects
converters.SpreadProperty = (path, context) /* : K.Spread */ => ({
  kind: 'spread',
  value: convert(path.get('argument'), context)
});

converters.UnaryExpression = (path, context) /* : K.Unary */ => ({
  kind: 'unary',
  operator: path.node.operator,
  argument: convert(path.get('argument'), context)
});

converters.JSXAttribute = (path, context) /* : K.JSXAttribute */ => ({
  kind: 'JSXAttribute',
  name: convert(path.get('name'), context),
  value: convert(path.get('value'), context)
});

converters.JSXExpressionContainer = (
  path,
  context
) /* : K.JSXExpressionContainer */ => ({
  kind: 'JSXExpressionContainer',
  expression: convert(path.get('expression'), context)
});

converters.JSXElement = (path, context) /* : K.JSXElement */ => ({
  kind: 'JSXElement',
  value: convert(path.get('openingElement'), context)
});

converters.JSXIdentifier = (path, context) /* : K.JSXIdentifier */ => ({
  kind: 'JSXIdentifier',
  value: path.node.name
});

converters.JSXMemberExpression = (
  path,
  context
) /* : K.JSXMemberExpression */ => ({
  kind: 'JSXMemberExpression',
  object: convert(path.get('object'), context),
  property: convert(path.get('property'), context)
});

converters.JSXOpeningElement = (path, context) /* : K.JSXOpeningElement */ => ({
  kind: 'JSXOpeningElement',
  name: convert(path.get('name'), context),
  attributes: path.get('attributes').map(item => convert(item, context))
});

converters.ClassProperty = (path, context) /* : K.Property */ => ({
  kind: 'property',
  key: convert(path.get('key'), context),
  value: convert(path.get('value'), context)
});

function convertCall(path, context) {
  const callee = convert(path.get('callee'), context);
  const args = path.get('arguments').map(a => convert(a, context));
  return { callee, args };
}

converters.CallExpression = (path, context) /* : K.Call */ => {
  const { callee, args } = convertCall(path, context);
  return {
    kind: 'call',
    callee,
    args
  };
};

converters.NewExpression = (path, context) /* : K.New */ => {
  const { callee, args } = convertCall(path, context);
  return {
    kind: 'new',
    callee,
    args
  };
};

converters.TypeofTypeAnnotation = (path, context) /* : K.Typeof */ => {
  const type = convert(path.get('argument'), { ...context, mode: 'value' });
  return {
    kind: 'typeof',
    type,
    name: resolveFromGeneric(type).name
  };
};

converters.ObjectProperty = (path, context) /* : K.Property */ => ({
  kind: 'property',
  key: convert(path.get('key'), context),
  value: convert(path.get('value'), context)
});

converters.ExistentialTypeParam = (path, context) /* : K.Exists */ => ({
  kind: 'exists'
});

converters.StringLiteral = (path, context) /* : K.String */ => ({
  kind: 'string',
  value: path.node.value
});

converters.NumericLiteral = (path, context) /* : K.Number */ => ({
  kind: 'number',
  value: path.node.value
});

converters.NullLiteral = (path, context) /* : K.Null */ => ({ kind: 'null' });

converters.BooleanLiteral = (path, context) /* : K.Boolean */ => ({
  kind: 'boolean',
  value: path.node.value
});

converters.ArrayExpression = (path, context) /* : K.ArrayExpression */ => ({
  kind: 'array',
  elements: path.get('elements').map(e => convert(e, context))
});

converters.BinaryExpression = (path, context) /* : K.BinaryExpression */ => ({
  kind: 'binary',
  operator: path.node.operator,
  left: convert(path.get('left'), context),
  right: convert(path.get('right'), context)
});

converters.MemberExpression = (path, context) /* : K.MemberExpression */ => ({
  kind: 'memberExpression',
  object: convert(path.get('object'), context),
  property: convert(path.get('property'), context)
});

function isTsIdentifier(path) {
  if (
    ['TSExpressionWithTypeArguments', 'TSTypeReference'].indexOf(
      path.parentPath.type
    ) !== -1 &&
    getIdentifierKind(path) === 'reference'
  ) {
    return true;
  }

  return false;
}

function convertParameter(param, context) /* : K.Param */ {
  const { type, ...rest } = convert(param, context);
  return {
    kind: 'param',
    value: rest,
    type: type || null
  };
}

function convertFunction(path, context) /* : K.Func */ {
  const parameters = path.get('params').map(p => convertParameter(p, context));
  let returnType = null;
  let id = null;

  if (path.node.returnType) {
    returnType = convert(path.get('returnType'), context);
  }

  if (path.node.id) {
    id = convert(path.get('id'), context);
  }

  return {
    kind: 'function',
    id,
    async: path.node.async,
    generator: path.node.generator,
    parameters,
    returnType
  };
}

converters.FunctionDeclaration = (path, context) =>
  convertFunction(path, context);

converters.ArrowFunctionExpression = (path, context) =>
  convertFunction(path, context);

converters.FunctionExpression = (path, context) =>
  convertFunction(path, context);

converters.TypeAnnotation = (path, context) =>
  convert(path.get('typeAnnotation'), context);

converters.ExistsTypeAnnotation = (path, context) /* : K.Exists */ => ({
  kind: 'exists'
});

converters.ObjectTypeAnnotation = (path, context) /* : K.Obj */ =>
  convertObject(path, context);

converters.ObjectTypeProperty = (path, context) /* : K.Property */ => {
  const result = {};
  result.kind = 'property';
  result.key = convert(path.get('key'), context);
  result.value = convert(path.get('value'), context);
  result.optional = path.node.optional;
  return result;
};

converters.UnionTypeAnnotation = (path, context) /* : K.Union */ => {
  const types = path.get('types').map(p => convert(p, context));
  return { kind: 'union', types };
};

converters.TypeParameterInstantiation = (
  path,
  context
) /* : K.TypeParams */ => ({
  kind: 'typeParams',
  params: path.get('params').map(p => convert(p, context))
});

converters.TypeParameterDeclaration = (
  path,
  context
) /* : K.TypeParamsDeclaration */ => ({
  kind: 'typeParamsDeclaration',
  params: path.get('params').map(p => convert(p, context))
});

converters.TypeParameter = (path, context) /* : K.TypeParam */ => ({
  kind: 'typeParam',
  name: path.node.name
});

converters.GenericTypeAnnotation = (path, context) /* : K.Generic */ => {
  const result = {};

  result.kind = 'generic';
  result.value = convert(path.get('id'), context);
  if (path.node.typeParameters) {
    result.typeParams = convert(path.get('typeParameters'), context);
  }
  return result;
};

converters.ObjectMethod = (path, context) /* : K.Func */ => {
  const parameters = path.get('params').map(p => convertParameter(p, context));
  let returnType = null;

  if (path.node.returnType) {
    returnType = convert(path.get('returnType'), context);
  }

  return {
    kind: 'function',
    id: null,
    async: path.node.async,
    generator: path.node.generator,
    parameters,
    returnType
  };
};

function convertObject(path, context) {
  let members = [];
  path.get('properties').forEach(p => {
    if (isExcludePropAnnotated(p)) return;
    const mem = convert(p, context);
    if (mem.kind === 'spread') {
      const memVal = resolveFromGeneric(mem.value);
      if (memVal.kind === 'initial' && memVal.value.kind === 'object') {
        members = members.concat(memVal.value.members);
      } else if (memVal.kind === 'object') {
        members = members.concat(memVal.members);
      } else if (memVal.kind === 'variable') {
        let declarations = memVal.declarations;
        declarations = declarations[declarations.length - 1].value;
        if (declarations.kind !== 'object') {
          throw new Error('Trying to spread a non-object item onto an object');
        } else {
          members = members.concat(declarations.members);
        }
      } else if (memVal.kind === 'import') {
        // We are explicitly calling out we are handling the import kind
        members = members.concat(mem);
      } else {
        // This is a fallback
        members = members.concat(mem);
      }
    } else if (mem.kind === 'property') {
      members.push(mem);
    }
  });
  return { kind: 'object', members };
}

converters.ObjectExpression = (path, context) /* : K.Obj */ =>
  convertObject(path, context);

converters.VariableDeclaration = (path, context) /* : K.Variable */ => {
  const res = {};
  res.kind = 'variable';
  res.declarations = path.get('declarations').map(p => convert(p, context));
  return res;
};

converters.VariableDeclarator = (path, context) /* : K.Initial */ => ({
  kind: 'initial',
  id: convert(path.get('id'), context),
  value: convert(path.get('init'), context)
});

converters.Identifier = (path, context) /* : K.Id */ => {
  const kind = getIdentifierKind(path);
  const name = path.node.name;

  if (context.mode === 'value') {
    const res = {};
    if (kind === 'reference') {
      const binding = path.scope.getBinding(name);

      if (binding) {
        const bindingPath = binding.path;
        let foundPath = null;

        if (bindingPath.isVariableDeclaration()) {
          foundPath = bindingPath
            .get('declarators')
            .find(p => p.node.name === name);
        } else if (bindingPath.isVariableDeclarator()) {
          foundPath = bindingPath.get('init');
        } else if (
          bindingPath.isImportDefaultSpecifier() ||
          bindingPath.isImportNamespaceSpecifier()
        ) {
          foundPath = bindingPath;
        } else if (bindingPath.isImportSpecifier()) {
          foundPath = bindingPath;
        } else if (bindingPath.isDeclaration()) {
          foundPath = bindingPath.get('id');
        }

        if (foundPath === null || foundPath === undefined) {
          throw new Error(
            `Unable to resolve binding path for: ${bindingPath.type}`
          );
        }
        const convertedValue = convert(foundPath, context);
        return {
          ...convertedValue,
          referenceIdName: path.node.name
        };
      }
      let type = null;

      if (path.node.typeAnnotation) {
        type = convert(path.get('typeAnnotation'), {
          ...context,
          mode: 'type'
        });
      }

      return {
        kind: 'id',
        name,
        type
      };
    }
    if (kind === 'static' || kind === 'binding') {
      let type = null;
      if (path.node.typeAnnotation) {
        type = convert(path.get('typeAnnotation'), {
          ...context,
          mode: 'type'
        });
      }

      return {
        kind: 'id',
        name,
        type
      };
    }
    throw new Error(`Unable to resolve path for: ${kind}`);
  } else if (context.mode === 'type') {
    if (kind === 'reference') {
      let bindingPath;

      if (isFlowIdentifier(path)) {
        const flowBinding = getTypeBinding(path, name);
        if (!flowBinding) throw new Error();
        bindingPath = flowBinding.path.parentPath;
      } else if (isTsIdentifier(path)) {
        const foundPath = path.scope.getBinding(name);
        if (
          foundPath &&
          (foundPath.path.isImportDefaultSpecifier() ||
            foundPath.path.isImportNamespaceSpecifier() ||
            foundPath.path.isImportSpecifier())
        ) {
          return convert(foundPath.path, context);
        }

        const tsBinding = getTypeBinding(path, name);
        if (!tsBinding) {
          return {
            kind: 'id',
            name
          };
        }
        bindingPath = tsBinding.path.parentPath;
      } else {
        bindingPath = path.scope.getBinding(name);
      }

      if (bindingPath) {
        if (bindingPath.kind === 'module') {
          bindingPath = bindingPath.path;
        }

        // If path is a descendant of bindingPath and share the same name, this is a recursive type.
        if (
          path.isDescendant(bindingPath) &&
          bindingPath.get('id').node.name === name
        ) {
          return { kind: 'id', name };
        }

        if (bindingPath.kind !== 'module') {
          return convert(bindingPath, context);
        }
      } else {
        return { kind: 'id', name };
      }
    } else if (kind === 'static' || kind === 'binding') {
      return { kind: 'id', name };
    }
  }
  throw new Error(`Could not parse Identifier ${name} in mode ${context.mode}`);
};

converters.TypeAlias = (path, context) => convert(path.get('right'), context);

converters.IntersectionTypeAnnotation = (
  path,
  context
) /* : K.Intersection */ => {
  const types = path.get('types').map(p => convert(p, context));
  return { kind: 'intersection', types };
};

converters.QualifiedTypeIdentifier = (path, context) =>
  convert(path.get('id'), context);

converters.VoidTypeAnnotation = (path) /* : K.Void */ => ({ kind: 'void' });

converters.BooleanTypeAnnotation = (path) /* : K.Boolean */ => ({
  kind: 'boolean'
});

converters.BooleanLiteralTypeAnnotation = (path) /* : K.Boolean */ => ({
  kind: 'boolean',
  value: path.node.value
});

converters.NullLiteralTypeAnnotation = (path) /* : K.Null */ => ({
  kind: 'null'
});

converters.StringLiteralTypeAnnotation = (path) /* : K.String */ => ({
  kind: 'string',
  value: path.node.value
});

// This should absolutely return a value
converters.NumberLiteralTypeAnnotation = (path) /* : K.Number */ => ({
  kind: 'number',
  value: path.node.value
});

converters.MixedTypeAnnotation = (path) /* : K.Mixed */ => ({ kind: 'mixed' });

converters.AnyTypeAnnotation = (path) /* : K.Any */ => ({ kind: 'any' });

converters.NumberTypeAnnotation = (path) /* : K.Number */ => ({
  kind: 'number'
});

converters.FunctionTypeParam = (path, context) =>
  convert(path.get('typeAnnotation'), context);

converters.TupleTypeAnnotation = (path, context) => ({
  kind: 'tuple',
  types: path.get('types').map(t => convert(t, context))
});

converters.FunctionTypeAnnotation = (path, context) /* : K.Func */ => {
  const parameters = path.get('params').map(p => convertParameter(p, context));
  const returnType = convert(path.get('returnType'), context);

  return {
    parameters,
    returnType,
    kind: 'function'
  };
};

converters.StringTypeAnnotation = (path) /* : K.String */ => ({
  kind: 'string'
});

converters.NullableTypeAnnotation = (path, context) /* : K.Nullable */ => ({
  kind: 'nullable',
  arguments: convert(path.get('typeAnnotation'), context)
});

converters.TSStringKeyword = (path) /* : K.String */ => ({ kind: 'string' });

converters.TSNumberKeyword = (path) /* : K.Number */ => ({ kind: 'number' });

converters.TSBooleanKeyword = (path) /* : K.Boolean */ => ({ kind: 'boolean' });

converters.TSVoidKeyword = (path) /* : K.Void */ => ({ kind: 'void' });

converters.TSUndefinedKeyword = (path, context) /* : K.Void */ => ({
  kind: 'void'
});

converters.TSTypeLiteral = (path, context) /* : K.Obj */ => ({
  kind: 'object',
  members: path.get('members').map(memberPath => convert(memberPath, context))
});

converters.TSPropertySignature = (path, context) /* : K.Property */ => ({
  kind: 'property',
  optional: !!path.node.optional,
  key: convert(path.get('key'), context),
  value: convert(path.get('typeAnnotation'), context)
});

converters.TSTypeAliasDeclaration = (path, context) /* : K.Obj */ =>
  convert(path.get('typeAnnotation'), context);

converters.TSLiteralType = (path) /* : K.String */ => ({
  kind: 'string',
  value: path.node.literal.value
});

converters.TSTypeReference = (path, context) /* : K.Generic */ => {
  const typeParameters = path.get('typeParameters');

  if (typeParameters.node) {
    return {
      kind: 'generic',
      typeParams: convert(typeParameters, context),
      value: convert(path.get('typeName'), context)
    };
  }

  return {
    kind: 'generic',
    value: convert(path.get('typeName'), context)
  };
};

converters.TSUnionType = (path, context) /* : K.Union */ => {
  const types = path.get('types').map(p => convert(p, context));
  return { kind: 'union', types };
};

converters.TSAnyKeyword = (path) /* : K.Any */ => ({ kind: 'any' });

converters.TSTupleType = (path, context) /* : K.Tuple */ => {
  const types = path.get('elementTypes').map(p => convert(p, context));
  return { kind: 'tuple', types };
};

converters.TSFunctionType = (path, context) /* : K.Generic */ => {
  const parameters = path
    .get('parameters')
    .map(p => convertParameter(p, context));
  const returnType = convert(path.get('typeAnnotation'), context);

  return {
    kind: 'generic',
    value: {
      kind: 'function',
      returnType,
      parameters
    }
  };
};

converters.TSMethodSignature = (path, context) /* : K.Property */ => ({
  kind: 'property',
  optional: !!path.node.optional,
  key: convert(path.get('key'), context),
  value: convertMethodCall(path, context)
});

converters.TSCallSignatureDeclaration = (path, context) /* : K.Property */ => ({
  kind: 'property',
  key: {
    kind: 'string'
  },
  optional: false,
  value: convertMethodCall(path, context)
});

converters.TSInterfaceDeclaration = (path, context) /* : K.Obj */ => {
  const extendedTypes = extendedTypesMembers(path, context);
  const interfaceType = convert(path.get('body'), context) || { members: [] };
  return {
    kind: 'object',
    // Merge the current interface members with any extended members
    members: interfaceType.members.concat(extendedTypes)
  };
};

converters.TSExpressionWithTypeArguments = (path, context) /* : K.Id */ =>
  convert(path.get('expression'), context);

converters.TSInterfaceBody = (path, context) /* : K.Obj */ => ({
  kind: 'object',
  members: path.get('body').map(prop => convert(prop, context))
});

converters.TSTypeAnnotation = (path, context) =>
  convert(path.get('typeAnnotation'), context);

converters.TSQualifiedName = (path, context) /* : K.Id */ => {
  const left = convert(path.get('left'), context);
  const right = convert(path.get('right'), context);

  return {
    kind: 'id',
    name: `${left.name}.${right.name}`
  };
};

converters.TSEnumDeclaration = (path, context) /* : K.Union */ => {
  const { name } = path.get('id').node;
  const types = path.get('members').map(p => {
    const member = convert(p, context);
    return {
      kind: member.kind,
      name: `${name}.${member.name}`
    };
  });
  return { kind: 'union', types };
};

converters.TSEnumMember = (path, context) => convert(path.get('id'), context);

converters.TSArray = (path, context) /* : K.Any */ => ({ kind: 'any' });

converters.TSArrayType = (path, context) /* : K.ArrayType */ => ({
  kind: 'arrayType',
  type: convert(path.get('elementType'), context)
});

converters.TSTypeParameterInstantiation = (
  path,
  context
) /* : K.TypeParams */ => ({
  kind: 'typeParams',
  params: path.get('params').map(param => convert(param, context))
});

converters.ImportNamespaceSpecifier = (path, context) /* : K.Any */ => ({
  kind: 'any'
});

converters.undefined = (path, context) /* : K.Any */ => ({ kind: 'any' });

converters.ObjectTypeSpreadProperty = (path, context) /* : K.Spread */ => ({
  kind: 'spread',
  value: convert(path.get('argument'), context)
});

converters.ArrayTypeAnnotation = (path, context) /* : K.ArrayType */ => ({
  kind: 'arrayType',
  type: convert(path.get('elementType'), context)
});

converters.TSIntersectionType = (path, context) /* : K.Intersection */ => {
  const types = path.get('types').map(type => convert(type, context));
  return { kind: 'intersection', types };
};

converters.TSIndexSignature = (path, context) /* : K.Property */ => {
  const id = path.get('parameters')[0];
  return {
    kind: 'property',
    key: {
      kind: 'id',
      name: `[${convert(id, context).name}: ${
        convert(id.get('typeAnnotation'), context).kind
      }]`
    },
    value: convert(path.get('typeAnnotation'), context)
  };
};

converters.TSParenthesizedType = (path, context) =>
  convert(path.get('typeAnnotation'), context);

converters.TSObjectKeyword = (path, context) /* : K.Obj */ => ({
  kind: 'object',
  members: []
});

converters.TSNullKeyword = (path, context) /* : K.Null */ => ({ kind: 'null' });

converters.TSThisType = (path, context) /* :K.This */ => ({
  kind: 'custom',
  value: 'this'
});

converters.ImportDefaultSpecifier = (path, context) /* : K.Import */ =>
  importConverterGeneral(path, context);

converters.ImportDeclaration = (path, context) /* : K.Import */ => {
  const importKind = path.node.importKind || 'value';
  const moduleSpecifier = path.get('source').node.value;
  const name = 'default';

  if (!context.replacementId) {
    return {
      kind: 'import',
      importKind,
      name,
      moduleSpecifier
    };
  }

  const filePath = resolveImportFilePathSync(path, context.resolveOptions);
  const file = loadFileSync(filePath, context.parserOpts);
  const exported = matchExported(file, context.replacementId.name);

  if (!exported) {
    return {
      kind: 'import',
      importKind,
      name,
      moduleSpecifier
    };
  }

  return convert(exported, context);
};

converters.ExportSpecifier = (path, context) /* : K.ExportSpecifier */ => {
  const local = convert(path.get('local'), context);
  const exported = convert(path.get('exported'), context);

  return {
    kind: 'exportSpecifier',
    local,
    exported
  };
};

converters.ExportNamedDeclaration = (path, context) /* : K.Export */ => {
  const specifiers = path.get('specifiers');
  // This needs to be in all of them --- let source = path.get('source');

  if (path.get('source').node) {
    const source = path.get('source');

    if (specifiers.length !== 1) {
      return {
        kind: 'export',
        exports: specifiers.map(s => convert(s, context)),
        source: convert(source, context)
      };
    }

    const name = convert(specifiers[0], context).local.name;

    let file;

    try {
      // The parentPath is a reference to where we currently are. We want to
      // get the source value, but resolving this first makes this easier.
      const filePath = resolveImportFilePathSync(
        source.parentPath,
        context.resolveOptions
      );

      const actualPath = resolveSync(
        nodePath.join(nodePath.dirname(filePath), source.node.value),
        context.resolveOptions
      );

      file = loadFileSync(actualPath, context.parserOpts);
      // We need to calculate name from the specifiers, I think knowing that there
      // will always be one specifier
      const resolvedValue = matchExported(file, name);

      if (resolvedValue) {
        return convert(resolvedValue, context);
      }
      return {
        kind: 'export',
        exports: specifiers.map(s => convert(s, context)),
        source: convert(source, context)
      };
    } catch (e) {
      return {
        kind: 'export',
        exports: specifiers.map(s => convert(s, context)),
        source: convert(source, context)
      };
    }
  } else {
    return {
      kind: 'export',
      exports: specifiers.map(s => convert(s, context))
    };
  }
};

converters.ImportSpecifier = (path, context) /* : K.Import */ =>
  importConverterGeneral(path, context);

// ########################################################################################

function extendedTypesMembers(path, context) {
  const members = path.get('extends');
  if (!members || !members.length) {
    return [];
  }

  return members.reduce((acc, current) => {
    const converted = convert(current, context);
    return acc.concat(converted.members);
  }, []);
}

function importConverterGeneral(path, context) /* : K.Import */ {
  const importKind = path.node.importKind || path.parent.importKind || 'value';
  const moduleSpecifier = path.parent.source.value;
  let name;
  const kind = path.parent.importKind;
  if (path.type === 'ImportDefaultSpecifier' && kind === 'value') {
    name = 'default';
  } else if (path.node.imported) {
    name = path.node.imported.name;
  } else {
    name = path.node.local.name;
  }

  if (!path.hub.file.opts.filename) {
    return {
      kind: 'import',
      importKind,
      name,
      moduleSpecifier
    };
  }
  if (kind === 'typeof') {
    throw new Error({ path, error: 'import typeof is unsupported' });
  }

  let filePath;

  try {
    filePath = resolveImportFilePathSync(
      path.parentPath,
      context.resolveOptions
    );
  } catch (e) {
    return {
      kind: 'import',
      importKind,
      name,
      moduleSpecifier
    };
  }

  if (!filePath) {
    return {
      kind: 'import',
      importKind,
      name,
      moduleSpecifier
    };
  }

  // Don't attempt to parse JSON
  if (nodePath.extname(filePath) === '.json') {
    return {
      kind: 'import',
      importKind,
      name,
      moduleSpecifier
    };
  }

  const file = loadFileSync(filePath, context.parserOpts);

  let id;
  if (path.node.imported) {
    id = path.node.imported.name;
  } else {
    id = path.node.local.name;
  }

  let exported = matchExported(file, name);

  if (!exported) {
    exported = recursivelyResolveExportAll(file.path, context, name);

    if (!exported) {
      return {
        kind: 'import',
        importKind,
        name,
        moduleSpecifier
      };
    }
  }

  return convert(exported, { ...context, replacementId: t.identifier(id) });
}

function recursivelyResolveExportAll(path, context, name) {
  const source = path
    .get('body')
    .filter(item => item.isExportAllDeclaration())
    .map(item => resolveExportAllDeclaration(item, context))
    .filter(Boolean);

  const matchedDeclartion = source.reduce((acc, current) => {
    if (acc) {
      return acc;
    }

    return matchExported(current, name);
  }, null);

  if (matchedDeclartion) {
    return matchedDeclartion;
  }

  return source.reduce((acc, current) => {
    if (acc) {
      return acc;
    }

    return recursivelyResolveExportAll(current.path, context, name);
  }, null);
}

function resolveExportAllDeclaration(path, context) {
  const source = path.get('source');
  // The parentPath is a reference to where we currently are. We want to
  // get the source value, but resolving this first makes this easier.
  const filePath = resolveImportFilePathSync(
    source.parentPath,
    context.resolveOptions
  );

  return loadFileSync(filePath, context.parserOpts);
}

function convertMethodCall(path, context) /* : K.Func */ {
  const parameters = path
    .get('parameters')
    .map(p => convertParameter(p, context));
  const returnType = convert(path.get('typeAnnotation'), context);

  return {
    kind: 'function',
    returnType,
    parameters
  };
}

function mapComment(comment) {
  return {
    type: comment.type === 'CommentLine' ? 'commentLine' : 'commentBlock',
    value: normalizeComment(comment),
    raw: comment.value
  };
}

function attachCommentProperty(source, dest, name) {
  if (!source || !source[name]) return;
  if (!dest[name]) dest[name] = [];

  const comments = source[name]
    .filter(
      comment =>
        comment.value.startsWith('*') && comment.type === 'CommentBlock'
    )
    .map(mapComment);
  dest[name] = dest[name].concat(comments);
}

function attachComments(source, dest) {
  attachCommentProperty(source, dest, 'leadingComments');
  attachCommentProperty(source, dest, 'trailingComments');
  attachCommentProperty(source, dest, 'innerComments');
}

// ####################################################################################
function convert(path, context) {
  if (typeof path.get !== 'function')
    throw new Error(
      `Did not pass a NodePath to convert() ${JSON.stringify(path)}`
    );
  const converter = converters[path.type];
  if (!converter) throw new Error(`Missing converter for: ${path.type}`);
  const result = converter(path, context);
  attachComments(path.node, result);
  return result;
}

// original entry point for this code, replaced by plugin one below
function extractReactTypes(
  code /* : string */,
  typeSystem /* : 'flow' | 'typescript' */,
  filename /* : ?string */,
  resolveOptions /* : ?Object */
) {
  const plugins = ['jsx'];
  if (!resolveOptions) resolveOptions = {};

  if (!resolveOptions.extensions) {
    // The resolve package that babel-file-loader uses only resolves .js files by default instead of the
    // default extension list of node (.js, .json and .node) so add .json back here.
    resolveOptions.extensions = ['.js', '.json'];
  }

  if (typeSystem === 'flow') {
    plugins.push('flow');
  } else if (typeSystem === 'typescript') {
    plugins.push('typescript');

    resolveOptions.extensions.push('.tsx');
    resolveOptions.extensions.push('.ts');
  } else {
    throw new Error('typeSystem must be either "flow" or "typescript"');
  }

  const parserOpts = createBabylonOptions({
    stage: 2,
    plugins
  });

  const file = createBabelFile(code, { parserOpts, filename });
  return convert(file.path, { resolveOptions, parserOpts });
}

function extractReactTypesForPlugin(path) {
  const resolveOptions = {
    extensions: ['.js', '.json']
  };
  const parserOpts = createBabylonOptions({
    stage: 2,
    plugins: ['jsx', 'flow']
  });
  return convert(path, { resolveOptions, parserOpts });
}

module.exports = {
  extractReactTypesForPlugin,
  extractReactTypes
};
