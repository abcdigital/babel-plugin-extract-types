![Presentation Layer](https://www.abc.net.au/homepage/2013/styles/img/abc.png)

# @abcaustralia/babel-plugin-extract-types

This is a Babel plugin that extracts type information about React component properties using Flow and adds this information as a `.__types` object to that component.

Based on a modifed fork of [extract-react-types](https://github.com/atlassian/extract-react-types).

## Install and Configure

Install:

`npm install @abcaustralia/babel-plugin-extract-types`

Add to Babel or babel-loader config in Webpack.


eg. `.babelrc`

```js
{
  "plugins": [
    "@abcaustralia/babel-plugin-extract-types"
  ]
}
```

eg. Webpack babel-loader config

```js
module: {
  rules: [
    {
      test: /\.m?js$/,
      use: {
        loader: 'babel-loader',
        options: {
          presets: [
            require.resolve('@babel/preset-react'),
            [require.resolve('@babel/preset-env'), { modules: false }],
            require.resolve('@babel/preset-flow')
          ],
          plugins: [
            [
              require.resolve('@babel/plugin-transform-runtime'),
              { regenerator: true }
            ],
            require.resolve('babel-plugin-dynamic-import-node'),
            require.resolve('babel-plugin-transform-class-properties'),
            require.resolve('@abcaustralia/babel-plugin-extract-types')
          ]
        }
      }
    }
  ]
}
```

## Using

Rather than relying on auto-detection of components, the plugin expects comment-style annotations to be added to the components to ensure the correct components are processed appropriately.

There are two annotations:

### `// @ReactComponent`

Add this immediately before the component declaration that you want to be processed.

```js
// @ReactComponent
class MyComponent extends React.Component <PropsT, StateT> {
  ...
}
```
```js
// @ReactComponent
const MyComponent = (props: PropT) => {
  ...
}
```

This is what the plugin looks for to identify a ReactComponent, be it a class or a function.


### `// @WithProps`

This is required for a specific type of Higher Order Component.  Specifically those in which the original component is wrapped by another but the same props are passed through without adding or removing any.  The annotation has to be applied to the composition of the HOC before export.  This copies `.__types` from the original to the exported HOC.

```js
// @ReactComponent
const MyComponent = (props: PropT) => {
  ...
}
/// @WithProps
const MyComponentWithDataLayer = withDataLayer(MyComponent);
export default MyComponentWithDataLayer;
```
