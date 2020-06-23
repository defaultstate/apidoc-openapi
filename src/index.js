const fs = require('fs');
const path = require('path');

const apidoc = require('apidoc-core');
const mkdirp = require('mkdirp');
const program = require('commander');
const _ = require('lodash');

const pkg = require('../package');

const contentType = 'application/json';


program
  .version(pkg.version)
  .option('-p, --project <path>', 'path to apidoc config file')
  .option('-s, --src <path>', 'path to source files')
  .option('-o, --out <path>', 'path to output file')
  .option('-t, --template <path>', 'path to OpenAPI template file', '')
  .option('-v, --verbose', 'be verbose');


class Logger {
  constructor() {
    this._verbose = program.verbose;
  }
  debug() {
    if (this._verbose) {
      console.log(arguments[0]);
    }
  }
  verbose() { this.debug(...arguments); }
  info() { this.debug(...arguments); }
  warn() { this.debug(...arguments); }
  error() {
    console.error(arguments[0]);
  }
}


function main() {
  const logger = new Logger();
  program.parse(process.argv);
  const cwd = process.cwd();
  const paths = {
    apidoc: path.resolve(cwd, program.project),
    src: path.resolve(cwd, program.src),
    out: program.out && path.resolve(cwd, program.out),
  };
  const { project, data } = getInput(paths, logger);

  logger.debug('APIDOC.PROJECT:\n' + JSON.stringify(project, null, 2));
  logger.debug('APIDOC.DATA:\n' + JSON.stringify(data, null, 2));

  const openapi = transformInput(project, data);
  let tmpl = {};
  if (program.template !== '' && fs.existsSync(program.template)) {
    const tmplPath = path.resolve(cwd, program.template);
    tmpl = JSON.parse(fs.readFileSync(tmplPath));
  }
  const combined = _.merge(tmpl, openapi);
  const output = JSON.stringify(combined, null, 2);
  if (paths.out) {
    fs.writeFileSync(program.out, output);
  } else {
    console.log(output);
  }
}
exports.main = main;


function getInput(paths, logger) {
  apidoc.setLogger(logger);
  if (paths.apidoc) {
    apidoc.setPackageInfos(require(paths.apidoc));
  }
  const result = apidoc.parse({
    src: paths.src,
  });
  return {
    project: JSON.parse(result.project),
    data: JSON.parse(result.data)
  };
}


function transformInput(project, data) {
  return {
    info: getInfo(project),
    servers: getServers(project),
    paths: getPaths(data),
    components: getComponents(),
    security: getSecurity(),
    tags: getTags(),
    externalDocs: getExternalDocs(),
  };
}

function getInfo(project) {
  return {
    title: project.title,
    description: project.description,
    version: project.version,
  };
}

function getServers(project) {
  return [
    {
      url: project.url,
    },
  ];
}


function getPaths(data) {
  const pathsObject = {};

  for (const item of data) {
    const endpoint = toPatternedFieldname(item.url);
    let pathItemObject = pathsObject[endpoint];
    if (!pathItemObject) {
      pathItemObject = pathsObject[endpoint] = {};
    }

    const httpMethod = item.type;
    const operationObject = pathItemObject[httpMethod] = {
      summary: item.title,
      description: item.description,
      operationId: `${item.group}.${item.name}`,
      parameters: [],
      requestBody: {},
      responses: {},
      tags: [
        item.group
      ]
    };
    const parameterObjects = operationObject.parameters;
    const requestBodyObject = operationObject.requestBody;
    const responsesObject = operationObject.responses;

    const params = [
      ...(item.header ? item.header.fields.Header : []),
      ...(item.parameter && item.parameter && item.parameter.fields && item.parameter.fields.Parameter ? item.parameter.fields.Parameter : []),
    ];
    if (item && item.parameter && item.parameter.fields) {
      const pathParams = item.parameter.fields['URI Parameter']
      if (Array.isArray(pathParams)) {
        for (const param of pathParams) {
         addParam(param, pathParams, parameterObjects)
        }
      }
    }
    for (const param of params) {
      const isHeader = param.group === 'Header';
      const isQueryParam = !isHeader && ['get', 'delete'].indexOf(httpMethod) !== -1;
      const isBodyParam = !isQueryParam;
      if (isHeader || isQueryParam) {
        const parameterObject = {
          name: param.field,
          description: param.description,
          in: (isHeader && 'header') || (isQueryParam && 'query'),
          required: !param.optional,
          content: {
            [contentType]: {
              schema: getSchema(params, param),
            },
          },
        };
        parameterObjects.push(parameterObject);
      } else if (isBodyParam) {
        // TODO: Is it possible to de-dup this block
        // to reuse `getSchema()` to handle the schema
        // entirely.
        if (!Object.keys(requestBodyObject).length) {
          Object.assign(requestBodyObject, {
            required: true,
            content: {
              [contentType]: {
                schema: {
                  type: 'object',
                  properties: {},
                  required: [],
                },
              },
            },
          });
        }
        const schema = requestBodyObject.content[contentType].schema;
        schema.properties[param.field] = getSchema(params, param);
        if (!param.optional) {
          schema.required.push(param.field);
        }
      }
    }
    const responseGroups = [
      ...(item.success ? Object.values(item.success.fields) : []),
      ...(item.error ? Object.values(item.error.fields) : []),
    ];
    for (const responses of responseGroups) {
      let responseObject;
      let schema;
      for (const response of filterParentParams(responses)) {
        if (!responseObject) {
          // apiDoc success group defaults to 'Success 200'.
          // apiDoc error group defaults to 'Error 4xx'.
          const statusCode = response.group.replace(/(Success|Error)\ /, '').toUpperCase();
          responseObject = {
            content: {
              [contentType]: {
                schema: {
                  type: 'object',
                  properties: {},
                  required: [],
                },
              },
            },
          };
          responsesObject[statusCode] = responseObject;
        }
        schema = responseObject.content[contentType].schema;
        schema.properties[response.field] = getSchema(responses, response);
        if (!response.optional) {
          schema.required.push(response.field);
        }
      }
    }

    if (item.deprecated) {
      operationObject.deprecated = true;
    }

    // if (!parameterObjects.length) {
    //   delete operationObject.parameters;
    // }
    if (!Object.keys(requestBodyObject).length) {
      delete operationObject.requestBody;
    }
  }

  return pathsObject;
}

function addParam(param, params, store) {
  const parameterObject = {
    name: param.field,
    description: param.description,
    in: 'path', //TODO handle query params
    required: !param.optional,
    content: {
      [contentType]: {
        schema: getSchema(params, param),
      },
    },
  };
  store.push(parameterObject);
}

function addRequest(req, reqs) {
}

function getComponents() { }

function getSecurity() {
}

function getTags() { }

function getExternalDocs() { }


function toPatternedFieldname(url) {
  return url.split('/').map((segment) => {
    if (segment[0] === ':') {
      return '{' + segment.slice(1) + '}';
    }
    return segment;
  }).join('/');
}


function filterParentParams(params) {
  return params.filter((param) => param.field.indexOf('.') === -1);
}


function getSchema(params, param) {
  const isObject = param.type === 'Object';
  const isArray = param.type && param.type.indexOf('[]') !== -1;
  const childParams = params.filter((p) => {
    const ppath = `${param.field}.`;
    return p.field.indexOf(ppath) === 0 &&
      p.field.replace(ppath, '').indexOf('.') === -1;
  });

  let schema;

  if (isObject) {
    schema = {
      type: 'object',
      properties: {},
      required: [],
    };
    for (const p of childParams) {
      const prop = p.field.replace(`${param.field}.`, '');
      schema.properties[prop] = getSchema(params, p);
      if (!p.optional) {
        schema.required.push(prop);
      }
    }
  } else if (isArray) {
    schema = {
      type: 'array',
      items: getSchema(params, Object.assign({}, param, {
        type: param.type.replace('[]', ''),
      })),
    };
  } else {
    schema = {
      type: param.type.toLowerCase(),
    };
    if (param.type.toLowerCase() === "string" && param.size) {
      schema.maxLength = param.size.replace('..','');
    }
    if (param.allowedValues) {
      schema.enum = param.allowedValues
    }
  }
  return schema;
}
main();
