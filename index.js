const { Database: sqlite } = require('sqlite3')

// 对 Database 异步函数进行 async 封装
;['run', 'get', 'all'].map (k => {
  [sqlite.prototype['_' + k], sqlite.prototype[k]]
    = [sqlite.prototype[k], function(sql, param) {
      return new Promise((resolve, reject) => {
        sql = sql.trim().replace(/\s+/g, ' ')
        param = param || []
        if (require.main === module) {
          const chalk = require('chalk')
          let log = chalk.cyan('query: ') + sql
          for (let p of param) {
            log = log.replace('?', chalk.magenta(`{{ ${p} }}`))
          }
          console.log('\n' + log)
        }
        this['_' + k](sql, param, (err, res) => {
          err ? reject(err) : resolve(res)
        })
      })
    }]
})

const READY_KEY = '__ready__'
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
  let untrustedKey = untrustedKeys.find(k => trustedKeys.indexOf(k) === -1)
  if (untrustedKey) {
    throw new Error(`no such column: ${untrustedKey}`)
  }
  return untrustedKeys
}

// 高级条件的解析，类似于 MongoSqlongo
const parseCriteria = (criteriaObject, schemaObject) => {
  let keys = filteredKeys(criteriaObject, schemaObject)
  let criteria = [], values = []
  keys.map(column => {
    let criterion = criteriaObject[column]
    if (typeof criterion === 'object') {
      let filteredCriterionKeys = filteredKeys(criterion, CRITERION_KEYS)
      filteredCriterionKeys.map(criterionKey => {
        if (Array.isArray(criterion[criterionKey])) {
          let placeholders = criterion[criterionKey].join(', ')
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
// 安全性：只需要开发者保证表名和表结构不受用户控制；除标明和表结构外的动态属性均进行了参数化处理
const Sqlongo = function (databaseName) {
  db = new sqlite(Sqlongo.defaults.path + databaseName + '.db')
  let schemas = {}
  return new Proxy ({}, {
    set (_, table, schema) {
      if (typeof schema !== 'object') {
        throw new Error(`db.${table}: schema must be an object`)
      }

      // 缓存表结构，以便后续做列名判断
      schemas[table] = schema

      // 此处由于是 Proxy 的赋值方法，无法 await，将不会等待建表完成
      // 因此需要保证所有对表的增删改查操作前有足够的 IO 等待时间（即增删改查放在路由处理中），以便等待建表完成
      /* await */ db.run(`
        create table if not exists ${table} (
          ${Object.keys(schema).map(k => k + ' ' + schema[k]).join(', ')}
        )
      `).then(() => {
        schemas[table][READY_KEY] = true
      })
      return true
    },
    get (_, key) {
      if (typeof key === 'symbol'
        || ['inspect', 'valueOf', 'toString', '__proto__'].indexOf(key) + 1) {
        return schemas[key]
      }

      if (key === 'raw') {
        return db.all.bind(db)
      }

      let table = key
      if (!schemas.hasOwnProperty(table)) {
        throw new Error(`db.${table} is called before setting its schema`)
      }
      if (!schemas[table][READY_KEY]) {
        throw new Error(`db.${table} is called before its schema is fully synchronized with database`)
      }
      return {
        async insert(row) {
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
        async remove(criteriaObj) {
          if (typeof criteriaObj !== 'object') {
            throw new Error(`remove: criteria should be an object`)
          }
          let [criteria, values] = parseCriteria(criteriaObj, schemas[table])
          criteria = criteria && `where (${criteria})`
          return await db.run(`
            delete from ${table} ${criteria}
          `, values)
        },
        async update(criteriaObj, row) {
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
        },
        async find(criteriaObj = {}, limit = -1, offset = 0) {
          if (typeof criteriaObj !== 'object') {
            throw new Error(`find: criteria should be an object`)
          }
          let [criteria, values] = parseCriteria(criteriaObj, schemas[table])
          criteria = criteria && `where (${criteria})`
          return await (limit === 1 ? db.get : db.all).call(db, `
            select * from ${table} ${criteria} limit ? offset ?
          `, values.concat([limit, offset]))
        }
      }
    }
  })
}

Sqlongo.defaults = { path: '' }
module.exports = Sqlongo

if (require.main === module) {
  const vm = require('vm')
  const repl = require('repl')
  const chalk = require('chalk')
  const ctx = { db: null }
  vm.createContext(ctx)

  const isRecoverableError = (error) => {
    if (error.name === 'SyntaxError') {
      return /^(Unexpected end of input|Unexpected token)/.test(error.message)
    }
    return false
  }

  repl.start({
    prompt: chalk.blue('\nsqlongo> '),
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
