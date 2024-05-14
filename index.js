const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const request = require('request');
const dns = require('dns');
const schedule = require('node-schedule');
const fs = require('fs');

let options = {
  flags: 'a', //
  encoding: 'utf8', // utf8编码
}
const file = fs.createWriteStream('./log.txt', options);
let logger = new console.Console(file, file);

const app = express();
const port = 8888; // 你可以根据需要更改端口号

// 指定数据库文件路径
const sqliteDbPath = '/usr/local/sqlite3/db/DomainManage.db';
//const sqliteDbPath = '/Users/niulina/Desktop/DomainManage.db';

// 创建数据库连接
const db = new sqlite3.Database(sqliteDbPath);

const successBody = (result) => {
  return {
    code: 10000,
    message: 'ok',
    result
  }
}

const errorBody = (result) => {
  return {
    code: 10001,
    message: 'error',
    result
  }
}

const batchRemoteDNSResolve = (objs, fn) => {
  return objs.map(o => {
    return new Promise(function (resolve, reject) {
      request(o.url, function (error, response, data) {
        if (error) {
          fn ? resolve(fn({id: o.id, ip: ''})) : resolve({id: o.id, ip: ''});
        } else {
          fn ? resolve(fn({id: o.id, ip: data})) : resolve({id: o.id, ip: data});
        }
      });
    });
  })
}

const batchDNSResolve = (objs, fn) => {
  return objs.map(o => {
    return new Promise(function (resolve, reject) {
      dns.lookup(o.url,null,(error,address,family) => {
        if (error) {
          fn ? resolve(fn({id: o.id, ip: ''})) : resolve({id: o.id, ip: ''});
        } else {
          address = (address === '127.0.0.1') ? '': address;
          fn ? resolve(fn({id: o.id, ip: address})) : resolve({id: o.id, ip: address});
        }
      });
    });
  })
}
const checkStatus = (applyScope, localIP, publicIP) => {
  // 已上线
  if (applyScope === '2' && publicIP !== '') return 2;
  if (applyScope === '1' && publicIP === '' && localIP !== '') return 2;
  // 未上线仅内网解析
  if (applyScope === '2' && publicIP === '' && localIP !== '') return 3;
  // 未解析
  if (!publicIP && !localIP) return 1;
  // 异常
  if (applyScope === '1' && publicIP !== '') return 4;
}

const checkEvents = (applyScope, newLocalIP, newPublicIP, oldLocalIP, oldPublicIP) => {
  // 申请外网，但是仅解析了内网
  if (applyScope === '2' && !newPublicIP && newLocalIP && !oldLocalIP) return 6;
  // 申请外网，上线
  if (applyScope === '2' && newPublicIP && !oldPublicIP) return 8;
  // 申请内网，上线
  if (applyScope === '1' && !oldLocalIP && newLocalIP) return 8;
  // 申请外网，外网转内网
  if (applyScope === '2' && oldPublicIP && !newPublicIP && newLocalIP) return 12;
  // 下线
  if ((!newLocalIP && oldLocalIP) || (!newPublicIP && oldPublicIP)) return 10;
}

// 中间件：解析请求体中的 JSON 数据
app.use(express.json());
app.use(cors());

// 路由：查询所有数据
app.get('/domains', (req, res) => {
  logger.log(new Date() + `/domains调用`);
  const { page = 1, perPage = 20, search = '', status = '0', type = '0', sort = '0' } = req.query;
  const statusSql = (status === '0') ? '' : ' AND (status like ' +  status + ')';
  const typeSql = (type === '0') ? '' : ' AND (type = ' +  type + ')';
  const sortSql = (sort === '0') ? ' ORDER BY _id DESC' : ' ORDER BY uptime DESC';
  const sql = 'SELECT * FROM domain' +
      ' where (domain LIKE \'%' +  search + '%\' or title like \'%' + search  + '%\' or fix_domain like \'%' +  search + '%\')' +
      statusSql +
      typeSql +
      sortSql +
      ' LIMIT ' + perPage * (page - 1) + ',' +  perPage;
  db.all(sql, (err, rowsAll) => {
    if (err) {
      logger.log(new Date() + `/domains调用失败:` + err);
      res.status(500).json({ ...errorBody(), description: '数据库查询失败' });
    } else {
      db.all('SELECT COUNT(_id) as total FROM domain where (domain LIKE \'%' +  search + '%\' or title like \'%' + search  + '%\' or fix_domain like \'%' + search  + '%\')' + statusSql + typeSql, (err, rows) => {
        if (err) {
          logger.log(new Date() + `/domains调用失败:` + err);
          res.status(500).json({ ...errorBody(), description: '数据库查询失败' });
        } else {
          logger.log(new Date() + `/domains调用成功`);
          res.json({
            ...successBody({data: rowsAll, page, perPage, total: rows[0].total})
          });
        }
      });
    }
  });
});

// 更新IP
const refreshIp = (mode = 'Auto') => {
  logger.log('/refreshIp');
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM domain', (err, rowsAll) => {
      if (err) {
        reject();
      } else {
        getIP(rowsAll, mode).then(() => {
          resolve();
        });
      }
    });
  });
}
const handleIP = (updateRows, publicIP, localIP, mode = 'Auto') => {
  const {_id, domain, title, status, apply_scope, server_IP, local_server_IP} = updateRows;
  const statusNew = checkStatus(apply_scope, localIP, publicIP) + '';
  let dateTime= (mode === 'Auto') ? new Date().setDate(new Date().getDate() - 1) : new Date().setDate(new Date().getDate());
  dateTime = new Date(dateTime);

  if (status && (status !== statusNew)) {
    const events = checkEvents(apply_scope, localIP, publicIP, local_server_IP, server_IP) || '99';
    const id = +new Date() + '_' + _id;
    const sqlAdd = db.prepare(`INSERT INTO events (_id, domain_id, domain, title, events, remark, detection_type) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    sqlAdd.run(id, _id, domain, title, events, '', '2');
  }

  if (status !== '2' && statusNew === '2') {
    const sqlModify = db.prepare(`UPDATE domain SET server_IP = ? ,local_server_IP = ?, status = ?, uptime = ? WHERE _id = ?`);
    logger.log(new Date() + `/更新domain表：id:` + _id + ',publicIP: ' + publicIP + ',localIP: ' + localIP + ',uptime: ' + Math.floor(+dateTime/1000));
    sqlModify.run(publicIP, localIP, statusNew, Math.floor(+dateTime/1000), _id);
  } else {
    const sqlModify = db.prepare(`UPDATE domain SET server_IP = ? ,local_server_IP = ?, status = ? WHERE _id = ?`);
    logger.log(new Date() + `/更新domain表：id:` + _id + ',publicIP: ' + publicIP + ',localIP: ' + localIP);
    sqlModify.run(publicIP, localIP, statusNew, _id);
  }
}
const getIP = (rowsAll, mode = 'Auto') => {
  return new Promise((resolve, reject) => {
    const publicObjs = rowsAll.map(r => {
      const domain = r.fix_domain || r.domain;
      const index = domain.indexOf('edu.cn') + 6;
      r.domain = domain.slice(0, index).replace(/https:\/\//gi, '').replace(/http:\/\//gi, '').replace(/www./gi, '');
      let url = 'http://119.29.29.29/d?dn=' + r.domain;
      return {
        id: r['_id'], url
      }
    });
    let publicPromises = batchRemoteDNSResolve(publicObjs, function (data) {
      return data;
    });

    const localObjs = rowsAll.map(r => {
      const domain = r.fix_domain || r.domain;
      const index = domain.indexOf('edu.cn') + 6;
      r.domain = domain.slice(0, index).replace(/https:\/\//gi, '').replace(/http:\/\//gi, '').replace(/www./gi, '');
      return {
        id: r['_id'], url: r.domain
      }
    });
    let localPromises = batchDNSResolve(localObjs, function (data) {
      return data;
    });

    Promise.all(publicPromises).then(function (publicValues) {
      Promise.all(localPromises).then((localValues) => {
        // 所有请求返回值
        db.serialize(() => {
          // 开始事务
          db.run('BEGIN TRANSACTION');
          // 使用循环将数据逐条插入到数据表中
          for (let v of publicValues) {
            let { id, ip} = v;

            const updateRows = rowsAll.find( r => r._id === id);

            const publicIP = (ip === '0') ? '' : ip.split(';')[0];
            const localIP = localValues.find(v => v.id === id).ip || '';

            logger.log('id:' + id + ', publicIP:' + publicIP + ', localIP:' + localIP);
            handleIP(updateRows, publicIP, localIP, mode);
          }

          // 提交事务
          db.run('COMMIT');
          resolve();
        });
      });
    }).catch(function (reason) {
      console.log(reason);
      reject();
    });
  })

}
app.get('/refreshIp', (req, res) => {
  logger.log(new Date() + `/refreshIp调用`);
  refreshIp('Manual').then(() => {
    logger.log(new Date() + `/refreshIp调用成功`);
    res.json({
      ...successBody(),
      description: '刷新成功'
    });
  }).catch(() => {
    logger.log(new Date() + `/refreshIp调用失败`);
    res.status(500).json({ ...errorBody(), description: '数据库查询失败' });
  });
});

// 添加域名
app.post('/domains/add', (req, res) => {
  // YMLX	域名类型
  // DWMC	单位名称
  // DWDM	单位代码
  // WZYT	网站用途
  // YMHY	域名含义
  // WZMC	网站名称
  // WZGLYXM	网站管理员姓名
  // WZGLYGH	网站管理员工号
  // SQYM	申请域名
  // DZYX	电子邮箱
  // FWFW	服务范围
  // LXFS	联系方式
  // DH	电话
  // LSH	流水号
  logger.log(new Date() + `/domains/add调用`);
  db.serialize(() => {
    // 开始事务
    db.run('BEGIN TRANSACTION');
    // 使用循环将数据逐条插入到数据表中
    for (let domain of req.body) {
      const { DWMC, DWDM, WZMC, WZGLYXM, SQYM, DZYX, FWFW, LXFS, LSH, LCJSSJ, YMLX} = domain;

      let sqlAdd = db.prepare(`INSERT INTO domain (_id, title, domain, affiliation_unit, administrator, administrator_phone, apply_scope, college, administrator_email, apply_time, type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      sqlAdd.run(LSH, WZMC, SQYM, DWMC, WZGLYXM, LXFS, FWFW, DWDM, DZYX, LCJSSJ, YMLX, 1, (err) => {
        if (!err) {
          db.all('SELECT * FROM domain where _id is ' + LSH, (err, rowsAll) => {
            if (!err) {
              getIP(rowsAll, 'Manal');
            }
          });
        }
      });
      logger.log(new Date() + `/domains/add` + LSH + '添加成功');
    }

    // 提交事务
    db.run('COMMIT');

    res.json({
      ...successBody(),
      description: '添加成功'
    });
  });
});

// 更新域名
app.post('/domains/update', (req, res) => {
  logger.log(new Date() + `/domains/update调用`);
  const id = req.body.id;
  const { remark,  security_incidents} = req.body;
  const sqlModify = db.prepare(`UPDATE domain SET remark = ?, security_incidents = ?  WHERE _id = ?`);
  sqlModify.run(remark, security_incidents, id, (err) => {
    if (err) {
      logger.log(new Date() + `/domains/update/` + id + ' ' + err);
      res.status(500).json({ error: '修改数据失败' });
    } else {
      logger.log(new Date() + `/domains/update/` + id + '修改成功');
      res.json({
        ...successBody(),
        description: '已修改数据'
      });
    }
  });
});

// --事件部分--
// 获取所有事件
app.get('/events', (req, res) => {
  logger.log(new Date() + `/events调用`);
  const { page = 1, perPage = 20, search = '', type = '0' } = req.query;
  const typeSql = (type === '0') ? '' : ' AND (events = ' +  type + ')';
  const sql = 'SELECT * FROM events' +
      ' where (domain LIKE \'%' +  search + '%\' or title like \'%' + search  + '%\')' +
      typeSql +
      ' ORDER BY _id DESC' +
      ' LIMIT ' + perPage * (page - 1) + ',' +  perPage;
  db.all(sql, (err, rowsAll) => {
    if (err) {
      logger.log(new Date() + `/events：` + err);
      res.status(500).json({ ...errorBody(), description: '数据库查询失败' });
    } else {
      db.all('SELECT COUNT(_id) as total FROM events where (domain LIKE \'%' +  search + '%\' or title like \'%' + search  + '%\')' + typeSql, (err, rows) => {
        if (err) {
          logger.log(new Date() + `/events：` + err);
          res.status(500).json({ ...errorBody(), description: '数据库查询失败' });
        } else {
          logger.log(new Date() + `/events数据库查询成功`);
          res.json({
            ...successBody({data: rowsAll, page, perPage, total: rows[0].total})
          });
        }
      });
    }
  });
});
// 添加事件
app.post('/events/add', (req, res) => {
  logger.log(new Date() + `/events/add调用`);
  const { id, domain, title, domainId, events, remark, detectionType, fixDomain } = req.body;
  const sqlAdd = db.prepare(`INSERT INTO events (_id, domain_id, domain, title, events, remark, detection_type) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  sqlAdd.run(id, domainId, domain, title, events, remark, detectionType, (err) => {
    if (err) {
      logger.log(new Date() + `/events/add：` + err);
      res.status(500).json({ error: '添加数据失败' });
    } else {
      if (events === '13') {
        // 域名变更
        const sqlModify = db.prepare(`UPDATE domain SET fix_domain = ? WHERE _id = ?`);
        sqlModify.run(fixDomain, domainId);
      }
      logger.log(new Date() + `/events/add/`+ id + '添加成功');
      res.json({
        ...successBody(),
        description: '已添加数据'
      });
    }
  });
});

app.post('/events/delete/:id', (req, res) => {
  logger.log(new Date() + `/events/delete/:id调用`);
  const id = req.params.id;
  const sqlModify = db.prepare(`DELETE FROM events WHERE _id = ?`);
  sqlModify.run(id, (err) => {
    if (err) {
      logger.log(new Date() + ` /events/delete/`+ id + `删除数据失败`);
      res.status(500).json({ error: '删除数据失败' });
    } else {
      logger.log(new Date() + ` /events/delete/`+ id + `删除数据成功`);
      res.json({
        ...successBody({data: true}),
        description: '已删除数据'
      });
    }
  });
});

// --双非部分--
// 获取所有双非域名
app.get('/doubleDomains', (req, res) => {
  logger.log(new Date() + `/doubleDomains调用`);
  const { page = 1, perPage = 20, search = '', status = '0' } = req.query;
  const statusSql = (status === '0') ? '' : ' AND (status like ' +  status + ')';
  const sql = 'SELECT * FROM doubleNoneDomain' +
      ' where (domain LIKE \'%' +  search + '%\' or title like \'%' + search  + '%\')' +
      statusSql +
      ' ORDER BY _id DESC' +
      ' LIMIT ' + perPage * (page - 1) + ',' +  perPage;
  db.all(sql, (err, rowsAll) => {
    if (err) {
      logger.log(new Date() + `/doubleDomains数据库查询失败`);
      res.status(500).json({ ...errorBody(), description: '数据库查询失败' });
    } else {
      db.all('SELECT COUNT(_id) as total FROM doubleNoneDomain where (domain LIKE \'%' +  search + '%\' or title like \'%' + search  + '%\')' + statusSql, (err, rows) => {
        if (err) {
          logger.log(new Date() + `/doubleDomains数据库查询失败`);
          res.status(500).json({ ...errorBody(), description: '数据库查询失败' });
        } else {
          logger.log(new Date() + `/doubleDomains数据库查询成功`);
          res.json({
            ...successBody({data: rowsAll, page, perPage, total: rows[0].total})
          });
        }
      });
    }
  });
});
// 更新双非数据
const getDoubleDomainsIP = (rowsAll) => {
  return new Promise((resolve, reject) => {
    const publicObjs = rowsAll.map(r => {
      const domain = r.fix_domain || r.domain;
      r.domain = domain.replace(/https:\/\//gi, '').replace(/http:\/\//gi, '').replace(/www./gi, '').replace(/\//gi, '');
      let url = 'https://xiaoapi.cn/API/sping.php?url=' + r.domain;
      return {
        id: r['_id'], url
      }
    });
    let publicPromises = batchRemoteDNSResolve(publicObjs, function (data) {
      return data;
    });

    Promise.all(publicPromises).then(function (publicValues) {
      // 所有请求返回值
      db.serialize(() => {
        // 开始事务
        db.run('BEGIN TRANSACTION');
        // 使用循环将数据逐条插入到数据表中
        for (let v of publicValues) {
          let { id, ip} = v;
          const reg = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
          const publicIP = ip.indexOf('不合法') > -1 ? '' : ip.match(reg)[0] || '';
          const sqlModify = db.prepare(`UPDATE doubleNoneDomain SET server_IP = ? WHERE _id = ?`);
          sqlModify.run(publicIP, id);
        }

        // 提交事务
        db.run('COMMIT');
        resolve();
      });
    }).catch(function (reason) {
      console.log(reason);
      reject();
    });
  })

}
app.get('/refreshDoubleDomainsIp', (req, res) => {
  db.all('SELECT * FROM doubleNoneDomain', (err, rowsAll) => {
    if (err) {
      res.status(500).json({ ...errorBody(), description: '数据库查询失败' });
    } else {
      getDoubleDomainsIP(rowsAll).then(() => {
        res.json({
          ...successBody(),
          description: '刷新成功'
        });
      });
    }
  });
});
// --Q&A部分--
// 获取所有QA
app.get('/qaItems', (req, res) => {
  logger.log(new Date() + `/qaItems调用`);
  const { page = 1, perPage = 20, search = '', status = '0' } = req.query;
  const sql = 'SELECT * FROM qa' +
      ' ORDER BY _id DESC';
  db.all(sql, (err, rowsAll) => {
    if (err) {
      logger.log(new Date() + ` /qaItems数据库查询失败`);
      res.status(500).json({ ...errorBody(), description: '数据库查询失败' });
    } else {
      logger.log(new Date() + ` /qaItems数据库查询成功`);
      res.json({
        ...successBody({data: rowsAll})
      });
    }
  });
});
// 添加QA
app.post('/qaItems/add', (req, res) => {
  logger.log(new Date() + `/qaItems/add调用`);
  const id = req.body.id;
  const { title,  description, tag} = req.body;
  const sqlAdd = db.prepare(`INSERT INTO qa (_id, title, description, tag) VALUES (?, ?, ?, ?)`);
  sqlAdd.run(id, title, description, tag, (err) => {
    if (err) {
      logger.log(new Date() + ` /qaItems/add/`+ id + `添加数据失败`);
      res.status(500).json({ error: '添加数据失败' });
    } else {
      logger.log(new Date() + ` /qaItems/add/`+ id + `添加数据成功`);
      res.json({
        ...successBody({data: true}),
        description: '已添加数据'
      });
    }
  });
});
// 更新QA
app.post('/qaItems/update', (req, res) => {
  logger.log(new Date() + `/qaItems/update调用`);
  const id = req.body.id;
  const { title,  description, tag} = req.body;
  const sqlModify = db.prepare(`UPDATE qa SET title = ?, description = ?, tag = ?  WHERE _id = ?`);
  sqlModify.run(title, description, tag, id, (err) => {
    if (err) {
      logger.log(new Date() + ` /qaItems/update/`+ id + `修改数据失败`);
      res.status(500).json({ error: '修改数据失败' });
    } else {
      logger.log(new Date() + ` /qaItems/update/`+ id + `修改数据成功`);
      res.json({
        ...successBody({data: true}),
        description: '已修改数据'
      });
    }
  });
});
// 删除QA
app.post('/qaItems/delete/:id', (req, res) => {
  logger.log(new Date() + `/qaItems/delete/:id调用`);
  const id = req.params.id;
  const sqlModify = db.prepare(`DELETE FROM qa WHERE _id = ?`);
  sqlModify.run(id, (err) => {
    if (err) {
      logger.log(new Date() + ` /qaItems/delete/`+ id + `删除数据失败`);
      res.status(500).json({ error: '删除数据失败' });
    } else {
      logger.log(new Date() + ` /qaItems/delete/`+ id + `删除数据成功`);
      res.json({
        ...successBody({data: true}),
        description: '已删除数据'
      });
    }
  });
});

// 定时任务
schedule.scheduleJob('00 10 01 * * *', function() {
  logger.log(new Date() + `定时任务启动`);
  refreshIp();
});

// 启动服务
app.listen(port, () => {
  logger.log(new Date() + `服务已启动，监听端口 ${port}`);
  console.log(`服务已启动，监听端口 ${port}`);
});

// 关闭数据库连接
process.on('SIGINT', () => {
  db.close();
  process.exit();
});