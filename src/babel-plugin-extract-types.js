// @noflow

const {
  extractReactTypesForPlugin
} = require('./extract-react-types/index.js');
const { isReactAnnotated, isWithPropsAnnotated } = require('./isAnnotated');

module.exports = function plugin(babel) {
  const { template } = babel;
  return {
    visitor: {
      Program(path, state) {
        try {
          const extractedTypes = extractReactTypesForPlugin(path);
          let types;
          if (extractedTypes) {
            /*
            The type information is either going to be in `classes` or `functions`
            neither is going to be undefined though, so we need to check length
            */
            if (extractedTypes.classes.length) types = extractedTypes.classes;
            if (extractedTypes.functions.length)
              types = extractedTypes.functions;
          }
          if (types) {
            const buildProp = template(` COMPONENT.__types = TYPEIMPORTS; `);

            path.traverse({
              ClassDeclaration(cdPath) {
                if (isReactAnnotated(cdPath)) {
                  const classname = cdPath.node.id.name;
                  path.pushContainer(
                    'body',
                    buildProp({
                      TYPEIMPORTS: JSON.stringify(types),
                      COMPONENT: classname
                    })
                  );
                }
              },
              VariableDeclaration(vdPath) {
                if (isReactAnnotated(vdPath) || isWithPropsAnnotated(vdPath)) {
                  const functionName = vdPath
                    .get('declarations')[0]
                    .get('id')
                    .get('name').node;
                  path.pushContainer(
                    'body',
                    buildProp({
                      TYPEIMPORTS: JSON.stringify(types),
                      COMPONENT: functionName
                    })
                  );
                }
              }
            });
          }
        } catch (error) {
          console.error(
            `\n\nbabel-plugin-extract-types error in: ${
              state.filename
            }\n${error}\n`
          );
        }
      }
    }
  };
};
