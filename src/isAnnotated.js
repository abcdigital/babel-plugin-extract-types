// @noflow

/** returns true if the babel AST nodepath passed represents
 * code with the preceeding comment of annotation
 */

function isAnnotated(path, annotation) {
  const leadingComments = path.node.leadingComments;

  const lastComment = leadingComments
    ? leadingComments[leadingComments.length - 1].value
        .split('\n')
        .map(lc => lc.replace(/^(\*|)\s*/gm, ''))
    : [];

  return lastComment.reduce((prev, curr) => {
    if (prev) return true;
    return curr.split(' ').indexOf(annotation) === 0;
  }, false);
}

const isReactAnnotated = path => isAnnotated(path, '@ReactComponent');
const isWithPropsAnnotated = path => isAnnotated(path, '@WithProps');
const isExcludePropAnnotated = path => isAnnotated(path, '@ExcludeProp');

module.exports = {
  isReactAnnotated,
  isWithPropsAnnotated,
  isExcludePropAnnotated
};
