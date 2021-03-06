const Builder = require('../tang/Builder')
const sortToAQL = require('./helpers/sortToAQL')
const returnToAQL = require('./helpers/returnToAQL')
const criteriaBuilder = require('./helpers/criteriaBuilder')
const asyncForEach = require('../tang/helpers/asyncForEach')
const setDefaultsToNull = require('./helpers/setDefaultsToNull')
const arrayOverride = require('./helpers/arrayOverride')
const createUniqueId = require('./helpers/createUniqueId')
const lodashGet = require('lodash/get')
const lodashSet = require('lodash/set')
const lodashUnset = require('lodash/unset')
const jsonStringify = require('../tang/helpers/jsonStringify')
const EXPR = /"expr\([\s+]?([\w\s.+-]+)\)"/gi
require('colors')

async function convertToAQLExpression(val, prop, target, path) {
  switch (typeof val) {
    case 'object':
      if (!(val instanceof Array)) {
        if (val.$inc != undefined) {
          target[prop] = 'EXPR(' + path.join('.') + '+' + val.$inc + ')'
        } else {
          await asyncForEach(val, convertToAQLExpression, path)
        }
      }
      break
    case 'string':
      if (val.match(/[+-=]{2}\s?\d/gi)) {
        target[prop] = 'EXPR(' + path.join('.') + val[0] + val.substr(2) + ')'
      }
      break
  }
}

class ORM {
  constructor() {
    this.aqlSegments = []
    this._variable = 'doc'
    this._counter = 0
    this._offset = 0
    this._criteria = {}
    this._separator = ''
    this._schemaOptions = {}
    this._options = {}
    this._subdocsOptions = {
      pulls: {},
      ignores: {}
    }
  }

  variable(val = 'doc') {
    this._variable = val
  }

  model(val) {
    this._model = val
    return this
  }

  connection(val) {
    this._connection = val
    return this
  }

  collection(val) {
    this._collection = val
    return this
  }

  criteria(val) {
    this._criteria = val
    return this
  }

  query(val) {
    this._query = val
    return this
  }

  schemaOptions(val = {}) {
    this._schemaOptions = val
    return this
  }

  options(val = {}) {
    this._options = val
    return this
  }

  action(val) {
    this._action = val
    return this
  }

  data(val) {
    this._data = val
    delete val._id
    delete val._key
    delete val._rev
    return this
  }

  computed(val) {
    this._computed = val
    return this
  }

  offset(val) {
    this._offset = val
    return this
  }

  limit(val) {
    this._limit = val
    return this
  }

  sort(val) {
    this._sort = val
    return this
  }

  select(val) {
    this._select = val
    return this
  }

  async toAQL(options = {}) {
    if (options.pretty) {
      this._separator = '\n   '
    }

    if (this._action === 'insert') {
      return this._createInsertQuery()
    }

    if (this._action === 'find') {
      return this._createFindQuery()
    }

    if (this._action === 'findEdge') {
      return this._createEdgeQuery()
    }

    if (this._action === 'update') {
      await this._createUpdateQuery()
      return this._createAQLQuery()
    }

    if (this._action === 'delete') {
      return this._createDeleteQuery()
    }
  }

  exec() {
    this._separator = '\n   '

    if (this._action === 'insert') {
      return this._insert()
    }

    if (this._action === 'find') {
      return this._find()
    }

    if (this._action === 'findEdge') {
      return this._findEdgebound()
    }

    if (this._action === 'update') {
      return this._update()
    }

    if (this._action === 'delete') {
      return this._delete()
    }
  }

  _createAQLForIn() {
    this.aqlSegments.push('FOR', this._variable, 'IN', this._collection.name)
  }

  _createAQLCustom() {
    let query = this._query
      .split('@@doc')
      .join(this._variable)
      .split('@@collection')
      .join(this._collection.name)
    this.aqlSegments.push(query)
  }

  _createAQLForInBound() {
    this.aqlSegments.push(
      'FOR',
      this._variable,
      'IN',
      this._criteria.inbound ? 'INBOUND' : 'OUTBOUND',
      `"${this._criteria.id}"`,
      this._criteria.collection
    )
  }

  _createAQLFilter() {
    if (Object.keys(this._criteria).length) {
      this.aqlSegments.push(
        this._separator + 'FILTER',
        criteriaBuilder(this._criteria, this._variable)
      )
    }
  }

  _createAQLLimit() {
    if (this._offset || this._limit) {
      this.aqlSegments.push(
        this._separator + 'LIMIT ' + this._offset + ',' + this._limit
      )
    }
  }

  _createAQLSort() {
    if (this._sort) {
      this.aqlSegments.push(
        this._separator + 'SORT ' + sortToAQL(this._sort, this._variable)
      )
    }
  }

  _createAQLOptions() {
    let opts = {}
    let hasOptions = false
    if (this._schemaOptions.hasOwnProperty('keepNull')) {
      opts.keepNull = false
      hasOptions = true
    }
    if (hasOptions) {
      this.aqlSegments.push('OPTIONS', JSON.stringify(opts))
    }
  }

  _createAQLReturn(distinct = false) {
    const returnItems = this._select
      ? returnToAQL(this._select, this._variable)
      : this._variable
    this.aqlSegments.push(
      this._separator + 'RETURN' + (distinct ? ' DISTINCT' : ''),
      returnItems
    )
  }

  /**
   * Parses subdocs and determines if items should be appended, removed or replaced
   * @param {*} arrayPaths
   * @param {*} data
   */
  _parseSubdocs(arrayPaths, data) {
    for (let i = 0; i < arrayPaths.length; i++) {
      const PATH_DOT = arrayPaths[i]
      let isNew = false
      let items = lodashGet(data, PATH_DOT)
      if (items && (items.isOverridden || items.$push || items.$pull)) {
        try {
          if (items.$push) {
            isNew = true
            items = items.$push
          }
        } catch (e) {}

        try {
          let pulls = items.pulls || items.$pull
          if (items.pulls || items.$pull) {
            this._subdocsOptions.pulls[PATH_DOT] = pulls
          }
        } catch (e) {}

        let subdocs = []
        if (items.length) {
          if (jsonStringify(items).indexOf('{') === -1) {
            subdocs = items
          } else {
            for (let i = 0; i < items.length; i++) {
              if (isNew || items[i].isNew) {
                items[i].$id = createUniqueId()
                subdocs.push(items[i])
              }
            }
          }
        }
        if (subdocs.length) {
          lodashSet(data, PATH_DOT, subdocs)
        } else {
          lodashUnset(data, PATH_DOT)
        }
      } else {
        this._subdocsOptions.ignores[PATH_DOT] = true
      }
    }
  }

  async _createAQLSubdocs(arrayPaths, data) {
    for (let i = 0; i < arrayPaths.length; i++) {
      const PATH_DOT = arrayPaths[i]
      const PATH_VAR = PATH_DOT.split('.').join('_')
      if (this._subdocsOptions.ignores[PATH_DOT]) {
        continue
      }
      let pullCriteria = this._subdocsOptions.pulls[PATH_DOT]
      let items = lodashGet(data, PATH_DOT) || []
      try {
        // if (items.$pull) {
        // pullCriteria = jsonStringify(items.$pull)
        // }
        if (items.$push) {
          isNew = true
          items = items.$push
        }
      } catch (e) {}

      let aql = `${this._variable}.${PATH_DOT}`

      // check if there are pulls
      if (pullCriteria) {
        // FOR doc IN users FILTER ((doc.`name` == "rob") OR (doc.`name` == "john")) RETURN doc
        // TODO: This needs to be refactored but just trying to get it working for now
        if (pullCriteria instanceof Array) {
          let ids = JSON.stringify(pullCriteria)
          aql =
            `MINUS(${this._variable}.${PATH_DOT}, ( ` +
            this._separator +
            `FOR item IN ${this._variable}.${PATH_DOT} || [] ` +
            this._separator +
            `FOR id IN ${ids} ` +
            this._separator +
            `FILTER item.$id == id ` +
            this._separator +
            `RETURN item` +
            this._separator +
            `))`
        } else {
          let orm = new ORM()
          orm.action('find')
          orm.variable('item')
          orm.collection({ name: `${this._variable}.${PATH_DOT}` })
          orm.criteria(pullCriteria)
          let subquery = await orm.toAQL()

          aql =
            `MINUS(${this._variable}.${PATH_DOT}, ( ` +
            this._separator +
            subquery +
            this._separator +
            `))`
        }
      }

      // check if there are pushes
      if (items.length) {
        let subdocsJSON = jsonStringify(items)
        aql = `APPEND(${aql}, ${subdocsJSON})`
      }

      // if there are pulls or pushes
      if (pullCriteria || items.length) {
        aql = `LET ${PATH_VAR} = ${aql}`
        this.aqlSegments.push(aql)
        lodashSet(data, PATH_DOT, '%' + PATH_VAR + '%')
      }
    }
  }

  _createAQLUpdate() {
    const removeOnMatchDefault = this._schemaOptions.removeOnMatchDefault
    const arrayPaths = this._model.schema._arrayPaths
    return new Promise(async (resolve, reject) => {
      const result = await Builder.getInstance()
        .data(this._data)
        .convertTo(this._model)
        .intercept(data => {
          this._parseSubdocs(arrayPaths, data)
          return data
        })
        .toObject({
          noDefaults: !this._options.withDefaults,
          // noDefaults: this._options.noDefaults || false,
          unknownProps: this._schemaOptions.strict ? 'strip' : 'allow'
        })
        .intercept(async data => {
          await asyncForEach(data, convertToAQLExpression)
          return data
        })
        .intercept(async data => {
          if (removeOnMatchDefault) {
            const defaultValues = this._model.schema.defaultValues
            data = await setDefaultsToNull(data, defaultValues)
          }
          return data
        })
        .intercept(async data => {
          await this._createAQLSubdocs(arrayPaths, data)
          return data
        })
        .exec()

      if (result instanceof Error) {
        return reject(result)
      }
      let SPECIAL_TAG = JSON.stringify(result).replace(/"%(\w+)%"/g, '$1')
      this.aqlSegments.push(`UPDATE ${this._variable} WITH ${SPECIAL_TAG}`)
      this.aqlSegments.push('IN ' + this._collection.name)
      // let query = this._createAQLQuery()
      // console.log(query)
      // resolve(query)
      resolve()
    })
  }

  _createAQLRemove() {
    this.aqlSegments.push('REMOVE ' + this._variable)
    this.aqlSegments.push('IN ' + this._collection.name)
  }

  _createAQLQuery(colorize = false) {
    let query = this.aqlSegments.join(' ').replace(EXPR, this._variable + '.$1')
    if (colorize) {
      query = query.replace(/\b([A-Z]+)\b/g, '\x1b[36m$1\x1b[0m')
    }
    return query
  }

  _createInsertQuery() {
    return 'NEW DOCUMENT'
  }

  _createFindQuery() {
    if (this._query) {
      this._createAQLCustom()
    } else {
      this._createAQLForIn()
      this._createAQLFilter()
    }
    this._createAQLLimit()
    this._createAQLSort()
    this._createAQLReturn()

    return this._createAQLQuery()
  }

  _insert() {
    return new Promise(async (resolve, reject) => {
      let data = await this._data.validate({
        noDefaults: true
      })
      let doc = await this._collection.save(data, {
        returnNew: this._options.returnNew
      })
      Object.assign(data, doc)
      return resolve(data)
    })
  }

  _find() {
    return new Promise(async resolve => {
      const query = this._createFindQuery()

      this._print(query)

      // perform query
      let cursor = await this._connection.db.query(query)
      let docs = await cursor.all()
      let builder = Builder.getInstance()
        .data(docs)
        .convertTo(this._model)

      if (!this._options.returnModel) {
        builder
          .toObject({
            computed: this._options.computed,
            noDefaults: this._options.noDefaults || false,
            unknownProps: this._schemaOptions.strict ? 'strip' : 'allow'
          })
          .intercept(target => {
            delete target._key
            return target
          })
      }

      let result = await builder.exec()

      const arrPaths = this._model.schema._arrayPaths

      if (result && this._options.returnSingle) {
        for (let i = 0; i < arrPaths.length; i++) {
          let arr = lodashGet(result[0], arrPaths[i])
          arrayOverride(arr)
        }

        return resolve(result[0])
      }

      return resolve(result)
    })
  }

  async _createEdgeQuery() {
    this._createAQLForInBound()
    this._createAQLReturn(true)

    return this._createAQLQuery()
  }

  _findEdgebound() {
    return new Promise(async resolve => {
      const query = await this._createEdgeQuery()

      this._print(query)

      // perform query
      let cursor = await this._connection.db.query(query)
      let docs = await cursor.all()
      let result = await Builder.getInstance()
        .data(docs)
        .convertTo(this._model)
        .toObject({
          computed: this._computed,
          noDefaults: this._options.noDefaults || false,
          unknownProps: this._schemaOptions.strict ? 'strip' : 'allow'
        })
        .intercept(target => {
          delete target._key
          return target
        })
        .exec()

      if (this._limit === 1 && result) {
        return resolve(result[0])
      }

      return resolve(result)
    })
  }

  async _createUpdateQuery() {
    this._createAQLForIn()
    this._createAQLFilter()
    this._createAQLLimit()
    this._createAQLSort()
    await this._createAQLUpdate()
    this._createAQLOptions()
    return this._createAQLQuery()
  }

  _update() {
    return new Promise(async resolve => {
      const query = await this._createUpdateQuery()

      this._print(query)

      await this._connection.db.query(query)

      return resolve()
    })
  }

  _createDeleteQuery() {
    this._createAQLForIn()
    this._createAQLFilter()
    this._createAQLLimit()
    this._createAQLSort()
    this._createAQLRemove()

    return this._createAQLQuery()
  }

  _delete() {
    return new Promise(async resolve => {
      const query = this._createDeleteQuery()

      this._print(query)

      let cursor = await this._connection.db.query(query)
      let docs = await cursor.all()
      return resolve(docs)
    })
  }

  _print(query) {
    // https://stackoverflow.com/questions/9781218/how-to-change-node-jss-console-font-color
    // https://misc.flogisoft.com/bash/tip_colors_and_formatting
    if (this._options.printAQL) {
      if (this._options.printAQL === 'color') {
        query = query.replace(/\b([A-Z]+)\b/g, '\x1b[36m$1\x1b[0m')
      }
      console.log('\n' + query + '\n')
    }
  }
}

module.exports = ORM
