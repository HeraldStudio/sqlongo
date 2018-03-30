const { Database } = require('sqlite3')

class AsyncDatabase extends Database {
  async run (sql, param = []) {
    return new Promise((resolve, reject) =>
      super.run(sql, param, (err, res) => {
        err ? reject(err) : resolve(res)
      })
    )
  }
  async get (sql, param = []) {
    return new Promise((resolve, reject) =>
      super.get(sql, param, (err, res) => {
        err ? reject(err) : resolve(res)
      })
    )
  }
  async all (sql, param = []) {
    return new Promise((resolve, reject) =>
      super.all(sql, param, (err, res) => {
        err ? reject(err) : resolve(res)
      })
    )
  }
}

const CRITERION_KEYS = {
  $like: 'like',
  $glob: 'glob',
  $gt: '>',
  $lt: '<',
  $gte: '>=',
  $lte: '<=',
  $ne: '<>',
  $eq: '=',
  $not: 'is not',
  $in: 'in'
}

// 将传入的 object 的 key 进行筛选，留下表结构中存在的 key，防止通过路由对象传参进行 SQL 注入
const filteredKeys = (untrustedObject, trustedObject) => {
  let trustedKeys = Object.keys(trustedObject)
  let untrustedKeys = Object.keys(untrustedObject)
  return untrustedKeys.filter(k => trustedKeys.indexOf(k) !== -1)
}

// 高级条件的解析，类似于 Mongo
const parseCriteria = (criteriaObject, schemaObject) => {
  let keys = filteredKeys(criteriaObject, schemaObject)
  let criteria = [], values = []
  keys.map(column => {
    let criterion = criteriaObject[column]
    if (typeof criterion === 'object') {
      let filteredCriterionKeys = filteredKeys(criterion, CRITERION_KEYS)
      filteredCriterionKeys.map(criterionKey => {
        if (Array.isArray(criterion[criterionKey])) {
          let placeholders = criterion[criterionKey].map(k => '?').join(', ')
          criteria.push(`${column} ${CRITERION_KEYS[criterionKey]} (${placeholders})`)
          values = values.concat(criterion[criterionKey])
        } else {
          criteria.push(`${column} ${CRITERION_KEYS[criterionKey]} ?`)
          values.push(criterion[criterionKey])
        }
      })
    } else {
      criteria.push(`${column} = ?`)
      values.push(criterion)
    }
  })
  return [criteria.join(' and '), values]
}

// ORM
// 安全性：只需要开发者保证表名和表结构不受用户控制；除表名和表结构外的动态属性均进行了参数化处理
const Sqlongo = function (databaseName) {
  if (!databaseName) {
    databaseName = ':memory:'
  } else {
    if (!/\.db$/.test(databaseName)) {
      databaseName += '.db'
    }
    let path = Sqlongo.defaults.path.replace(/^(.+)\/?$/, '$1/')
    databaseName = path + databaseName.replace(/^\//, '')
  }
  const db = new AsyncDatabase(databaseName)
  let createTableTasks = Promise.resolve()
  let schemas = {}
  let proxy = new Proxy ({}, {
    set (_, table, schema) {
      if (typeof schema !== 'object') {
        throw new Error(`db.${table}: schema must be an object`)
      }
      schemas[table] = schema

      createTableTasks = Promise.all([createTableTasks, db.run(`
        create table if not exists ${table} (
          ${Object.keys(schema).map(k => k + ' ' + schema[k]).join(', ')}
        )
      `)])
      return true
    },
    get (_, key) {
      if (typeof key === 'symbol' || key in Object.prototype) {
        return schemas[key]
      }

      if (key === 'raw') {
        return async (sql, params) => {
          await createTableTasks
          return await db.all(sql, params)
        }
      }

      let table = key

      return {
        async find(criteriaObj = {}, limit = -1, offset = 0) {
          await createTableTasks
          if (typeof criteriaObj !== 'object') {
            throw new Error(`find: criteria should be an object`)
          }
          let [criteria, values] = parseCriteria(criteriaObj, schemas[table])
          criteria = criteria && `where (${criteria})`
          return await (limit === 1 ? db.get : db.all).call(db, `
            select * from ${table} ${criteria} limit ? offset ?
          `, values.concat([limit, offset]))
        },
        async count(column = '*', criteriaObj = {}) {
          await createTableTasks
          if (typeof column === 'object') {
            criteriaObj = column
            column = '*'
          }
          if (typeof criteriaObj !== 'object') {
            throw new Error(`count: criteria should be an object`)
          }
          if (column !== '*' && !Object.keys(schemas[table]).indexOf(column)) {
            throw new Error(`count: column ${column} does not exist`)
          }
          let [criteria, values] = parseCriteria(criteriaObj, schemas[table])
          criteria = criteria && `where (${criteria})`
          return (await db.get(`
            select count(${column}) count from ${table} ${criteria}
          `, values)).count
        },
        async distinct(column, criteriaObj = {}, limit = -1, offset = 0) {
          await createTableTasks
          if (typeof criteriaObj !== 'object') {
            throw new Error(`distinct: criteria should be an object`)
          }
          if (!Object.keys(schemas[table]).indexOf(column)) {
            throw new Error(`distinct: column ${column} does not exist`)
          }
          let [criteria, values] = parseCriteria(criteriaObj, schemas[table])
          criteria = criteria && `where (${criteria})`
          return (await (limit === 1 ? db.get : db.all).call(db, `
            select distinct ${column} from ${table} ${criteria} limit ? offset ?
          `, values.concat([limit, offset]))).map(k => k[column])
        },
        async insert(row) {
          await createTableTasks
          if (typeof row !== 'object') {
            throw new Error(`insert: row should be an object`)
          }

          let keys = filteredKeys(row, schemas[table])
          let values = keys.map(k => row[k])
          let placeholders = keys.map(k => '?').join(', ')
          keys = keys.join(', ')

          return await db.run(`
            insert into ${table}(${keys}) values(${placeholders})
          `, values)
        },
        async remove(criteriaObj, limit = -1, offset = 0) {
          await createTableTasks
          if (typeof criteriaObj !== 'object') {
            throw new Error(`remove: criteria should be an object`)
          }
          let [criteria, values] = parseCriteria(criteriaObj, schemas[table])
          criteria = criteria && `where (${criteria})`
          return await db.run(`
            delete from ${table} where rowid in (select rowid from ${table} ${criteria} limit ? offset ?)
          `, values.concat([limit, offset]))
        },
        async update(criteriaObj, row) {
          await createTableTasks
          if (typeof criteriaObj !== 'object') {
            throw new Error(`update: criteria should be an object`)
          }
          if (typeof row !== 'object') {
            throw new Error(`update: row should be an object`)
          }
          let [criteria, criteriaValues] = parseCriteria(criteriaObj, schemas[table])
          criteria = criteria && `where (${criteria})`

          let keys = filteredKeys(row, schemas[table])
          let values = keys.map(k => row[k])
          let operations = keys.map(k => `${k} = ?`).join(', ')

          return await db.run(`
            update ${table} set ${operations} ${criteria}
          `, values.concat(criteriaValues))
        }
      }
    }
  })
  return proxy
}

Sqlongo.defaults = { path: '' }
module.exports = Sqlongo
module.exports.AsyncDatabase = AsyncDatabase

if (require.main === module) {
  const vm = require('vm')
  const repl = require('repl')
  const chalk = require('chalk')
  const ctx = { db: new Sqlongo() }
  vm.createContext(ctx)

  process.on('unhandledRejection', e => { throw e })

  const isRecoverableError = (error) => {
    if (error.name === 'SyntaxError') {
      return /^(Unexpected end of input|Unexpected token)/.test(error.message)
    }
    return false
  }

  console.log('\nUsing in-memory temporary database by default.')
  console.log('Type ' + chalk.blue('use [filename]') + ' to open or create a database.')

  repl.start({
    prompt: '\nsqlongo> ',
    eval: async (cmd, context, filename, callback) => {
      if (/^use\s+(\S+)$/.test(cmd.trim())) {
        let name = RegExp.$1
        ctx.db = new Sqlongo(name)
        console.log(`\nswitched to ${name}.db`)
        return callback()
      }
      try {
        let result = vm.runInContext(cmd, ctx)
        if (result != null && result.toString() === '[object Promise]') {
          result = await result
        }
        if (typeof result !== 'undefined') {
          console.log('')
          console.log(result)
        }
        callback()
      } catch (e) {
        if (isRecoverableError(e)) {
          return callback(new repl.Recoverable(e));
        } else {
          console.error(e)
        }
      }
    }
  })
}
