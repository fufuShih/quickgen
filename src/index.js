const fs = require('fs');
const path = require('path');
const glob = require('glob');
const babel = require('@babel/core');
const generator = require('@babel/generator').default;
const parser = require('@babel/parser');

const propsCache = new Map();

const reactJsDocPlugin = () => {
  return {
    visitor: {
      Program: {
        exit(path, state) {
          const filename = state.filename;
          let componentInfo = {
            name: '',
            props: new Set(),
            hasSpreadProps: false,
            hasExistingJsDoc: false,
            nodePath: null
          };

          // Check for existing JSDoc
          const checkForExistingJsDoc = (comments) => {
            if (!comments) return false;
            return comments.some(comment => 
              comment.type === 'CommentBlock' && 
              comment.value.includes('@component')
            );
          };

          // Analyze components
          path.traverse({
            // Function declarations (including export default function)
            FunctionDeclaration(path) {
              if (!componentInfo.name && isReactComponent(path.node)) {
                componentInfo.name = path.node.id.name;
                componentInfo.nodePath = path;
                if (!checkForExistingJsDoc(path.node.leadingComments)) {
                  analyzeComponent(path, componentInfo);
                }
              }
            },
            // Arrow functions and function expressions
            VariableDeclaration(path) {
              const declaration = path.node.declarations[0];
              if (declaration && declaration.init) {
                let init = declaration.init;
                
                // Handle wrapped components (memo, forwardRef)
                if (init.type === 'CallExpression' && 
                    (init.callee.name === 'memo' || init.callee.name === 'forwardRef')) {
                  init = init.arguments[0];
                }

                if (isReactComponent(init)) {
                  componentInfo.name = declaration.id.name;
                  componentInfo.nodePath = path;
                  if (!checkForExistingJsDoc(path.node.leadingComments)) {
                    analyzeComponent(path, componentInfo);
                  }
                }
              }
            },
            // Export default function
            ExportDefaultDeclaration(path) {
              const declaration = path.node.declaration;
              if (declaration.type === 'FunctionDeclaration' && isReactComponent(declaration)) {
                componentInfo.name = declaration.id?.name || 'AnonymousComponent';
                componentInfo.nodePath = path;
                if (!checkForExistingJsDoc(path.node.leadingComments)) {
                  analyzeComponent(path, componentInfo);
                }
              }
            }
          });

          if (componentInfo.name && componentInfo.props.size > 0 && componentInfo.nodePath) {
            console.log('Generating JSDoc for:', componentInfo.name);
            
            const jsDoc = generateJsDoc(
              componentInfo.name, 
              Array.from(componentInfo.props), 
              componentInfo.hasSpreadProps
            );

            // Get the original code
            const originalCode = state.file.code;
            const targetNode = componentInfo.nodePath.node;
            const startLine = targetNode.loc.start.line;

            // Calculate indentation from the original code
            const lines = originalCode.split('\n');
            const componentLine = lines[startLine - 1];
            const indentation = componentLine.match(/^\s*/)[0];

            // Create JSDoc with proper indentation
            const jsDocLines = jsDoc.split('\n').map(line => indentation + line).join('\n');
            const formattedJsDoc = `/**\n${jsDocLines}*/\n${indentation}`;

            // Store for later use
            propsCache.set(filename, {
              componentName: componentInfo.name,
              props: Array.from(componentInfo.props),
              hasSpreadProps: componentInfo.hasSpreadProps,
              modified: true,
              jsDoc: formattedJsDoc,
              lineNumber: startLine
            });

            console.log('Added JSDoc to:', componentInfo.name);
          }
        }
      }
    }
  };
};

function isReactComponent(node) {
  if (!node) return false;
  
  // Improved JSX detection
  const isJSX = (type) => {
    return type === 'JSXElement' || 
           type === 'JSXFragment' || 
           type === 'JSXText' ||
           type === 'JSXFragment';
  };

  // Check if it's wrapped in memo or other HOCs
  const isWrappedComponent = (node) => {
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      // Check for memo(Component) pattern
      if (callee.type === 'Identifier' && 
          (callee.name === 'memo' || callee.name === 'forwardRef')) {
        const args = node.arguments;
        return args.length > 0 && isReactComponent(args[0]);
      }
    }
    return false;
  };

  // For arrow functions and function expressions
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    // Direct JSX return
    if (isJSX(node.body?.type)) {
      return true;
    }
    // Block with return statement
    if (node.body?.type === 'BlockStatement') {
      return node.body.body.some(statement => 
        statement.type === 'ReturnStatement' && 
        statement.argument && 
        (isJSX(statement.argument.type) || isWrappedComponent(statement.argument))
      );
    }
  }

  // For function declarations
  if (node.type === 'FunctionDeclaration') {
    return node.body.body.some(statement => 
      statement.type === 'ReturnStatement' && 
      statement.argument && 
      (isJSX(statement.argument.type) || isWrappedComponent(statement.argument))
    );
  }

  // For wrapped components (memo, forwardRef, etc.)
  if (isWrappedComponent(node)) {
    return true;
  }

  return false;
}

function analyzeComponent(path, componentInfo) {
  // Analyze props from parameters
  if (path.node.params && path.node.params[0]) {
    const firstParam = path.node.params[0];
    if (firstParam.type === 'ObjectPattern') {
      firstParam.properties.forEach(prop => {
        if (prop.type === 'ObjectProperty') {
          componentInfo.props.add(prop.key.name);
        } else if (prop.type === 'RestElement') {
          componentInfo.hasSpreadProps = true;
        }
      });
    }
  }

  // Analyze props usage in the component body
  path.traverse({
    MemberExpression(path) {
      if (path.node.object.name === 'props') {
        componentInfo.props.add(path.node.property.name);
      }
    },
    SpreadElement(path) {
      if (path.node.argument.name === 'props') {
        componentInfo.hasSpreadProps = true;
      }
    }
  });

  console.log('Analyzing component:', componentInfo.name);
  console.log('Found props:', Array.from(componentInfo.props));
}

function generateJsDoc(componentName, props, hasSpreadProps) {
  let doc = '';
  doc += ` * @component ${componentName}\n`;
  doc += ` * @description React component\n`;
  doc += ` * @param {Object} props Component props\n`;
  
  props.forEach(prop => {
    doc += ` * @param {*} props.${prop} - ${prop} prop\n`;
  });

  if (hasSpreadProps) {
    doc += ` * @param {...*} props.spread - Additional props are spread\n`;
  }

  doc += ` * @returns {JSX.Element} React component\n`;
  
  return doc;
}

async function generateDocs(directory) {
  try {
    console.log('🔍 Scanning directory:', directory);
    const files = glob.sync(path.join(directory, '**/*.{js,jsx}'));
    
    if (files.length === 0) {
      console.log('⚠️ No JavaScript/React files found in directory');
      return;
    }

    console.log(`📝 Found ${files.length} files to process...`);
    
    let processedCount = 0;
    let skippedCount = 0;
    
    for (const file of files) {
      const absolutePath = path.resolve(file);
      let code = fs.readFileSync(file, 'utf-8');
      
      try {
        const result = await babel.transformAsync(code, {
          filename: absolutePath,
          plugins: [reactJsDocPlugin],
          parserOpts: {
            plugins: ['jsx'],
            sourceType: 'module'
          },
          retainLines: true,
          comments: true
        });

        const cacheInfo = propsCache.get(absolutePath);
        if (result && cacheInfo && cacheInfo.modified) {
          // Insert JSDoc at the correct position
          const lines = code.split('\n');
          lines.splice(cacheInfo.lineNumber - 1, 0, cacheInfo.jsDoc);
          code = lines.join('\n');

          fs.writeFileSync(file, code);
          console.log(`✅ Generated JSDoc for ${cacheInfo.componentName} in ${file}`);
          processedCount++;
        } else {
          console.log(`⚠️ Skipped ${file} - No React component found or already documented`);
          skippedCount++;
        }
      } catch (error) {
        console.error(`❌ Error processing ${file}:`, error.message);
        skippedCount++;
      }
    }

    console.log('\n📊 Summary:');
    console.log(`Total files found: ${files.length}`);
    console.log(`Files updated: ${processedCount}`);
    console.log(`Files skipped: ${skippedCount}`);

  } catch (error) {
    console.error('❌ Error during generation:', error);
    throw error;
  }
}

module.exports = {
  generateDocs,
  reactJsDocPlugin
};