const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path')
const request = require('request');
const mongoose = require('mongoose');
const inquirer = require('inquirer')

let USERNAME = ''
let PROJECTNAME = ''
let ISSUESTATUS = ''
let SAVEMETHODS = ''

/**
 * 延迟公共函数
 */
let timeout = function (delay) {
    console.log('延迟函数：', `延迟 ${delay} 毫秒`)
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            try {
                resolve(1)
            } catch (error) {
                reject(error)
            }
        }, delay);
    })
}

/**
 * shell 交互
 */

class shellIO {
    constructor() {}
    async init() {
        await inquirer.prompt([{
            type: 'input',
            name: 'username',
            message: '请输入github用户名:',
        }]).then((answers) => {
            USERNAME = answers.username
        })
        await inquirer.prompt([{
            type: 'input',
            name: 'projectname',
            message: '请输入github项目名:',
        }]).then((answers) => {
            PROJECTNAME = answers.projectname
        })
        await inquirer.prompt([{
            type: 'list',
            name: 'issueStatus',
            message: '请选择issue类型:',
            choices: ['open', 'close']
        }]).then((answers) => {
            ISSUESTATUS = answers.issueStatus
        })
        await inquirer.prompt([{
            type: 'list',
            name: 'savemethods',
            message: '请选择数据保存方式(如果选择mongoDB,请确保已经正确开启服务，并存在github-issue collection):',
            choices: ['json', 'mongoDB']
        }]).then((answers) => {
            SAVEMETHODS = answers.savemethods
        })
    }
}

/**
 * 数据库相关
 */
class database {
    constructor() {
        this.model = {}
    }
    /**
     * 初始化数据库
     */
    async init() {
        mongoose.connect('mongodb://localhost/github-issue', (err) => {
            if (err) {
                console.log('连接失败');
                console.log(err);
                process.exit(1);
            }
        })
        const db = mongoose.connection
        db.once('open', (callback) => {
            console.log('MongoDB连接成功！！')
        })
        const issueSchema = new mongoose.Schema({
            issueName: String,
            issueNo: Number,
            issueTime: String,
            issuesType: [String],
            issueAnswers: String,
            issueReporter: String
        })
        this.model = await db.model(`${USERNAME}-${PROJECTNAME}-${ISSUESTATUS}`, issueSchema) // newClass为创建或选中的集合
    }
    /**
     * 插入数据
     */
    async insertData(data) {
        try {
            console.log('正在插入数据');
            await this.model.create(data)
            console.log('数据插入成功');
        } catch (error) {
            console.log(error);
        }
    }
}
/**
 * One 爬虫类
 */
class OnePaChong {
    constructor() {
        this.page = 1
        this.resultList = []
        this.mongo = {}
        this.closeParams = 'q=is%3Aissue+is%3Aclosed'
        this.openParams = 'q=is%3Aopen+is%3Aissue'
        // 初始化
    }
    // 初始化函数
    async init() {
        if (SAVEMETHODS == 'mongoDB') {
            console.log('正在启动mongodb');
            this.mongo = new database()
            await this.mongo.init()
        }
        console.log('正在启动浏览器...')
        console.time("cralwer");
        let browser = await puppeteer.launch({
            headless: true
        });
        console.log('正在打开新页面...')
        let page = await browser.newPage();
        await page.setViewport({
            width: 1440,
            height: 960
        })
        while (true) {
            try {
                console.log(`正在爬取第${this.page}页issue`);
                await page.goto(`https://github.com/${USERNAME}/${PROJECTNAME}/issues?page=${this.page}&${ISSUESTATUS=='open'?this.openParams:this.closeParams}`)
                await page.waitFor('.repository-content', {
                    timeout: 10000
                })
                let lastPageText = await this.getTotlePage(page)
                let result = await this.getIssue(page)
                if (SAVEMETHODS == 'mongoDB') {
                    await this.mongo.insertData(result)
                }
                this.resultList = this.resultList.concat(result)
                if (this.page <= lastPageText) {
                    this.page++
                } else {
                    console.log(`-------------------------------------------------`)
                    console.log(`爬虫结束`)
                    console.log(`共爬了${this.page}页`)
                    console.log(`${this.resultList.length}条数据`)
                    console.timeEnd("cralwer");
                    console.log(`-------------------------------------------------`)
                    if (SAVEMETHODS == 'json') {
                        fs.writeFile(`./json/${USERNAME}-${PROJECTNAME}-${ISSUESTATUS}.json`, JSON.stringify(this.resultList), function (err) {
                            if (err) throw err;
                            console.log("Export Account Success!");
                        });
                    }
                    await this.closeBrowser(browser)
                    return
                }
            } catch (error) {
                console.log(error)
                console.log(`-------------------------------------------------`)
                console.log('出错啦，正在截图')
                await page.screenshot({
                    path: `./screenshot/${USERNAME}-${PROJECTNAME}-${this.page}.png`
                })
                let title = await page.title()
                if (title.includes('Page not found')) {
                    console.log('页面404');
                    process.exit(1)
                }
            }
        }
    }
    /**
     * 获取issue并解析
     * @param {*} page page实例
     */
    async getIssue(page) {
        try {
            const ITEM = '#js-repo-pjax-container > div.container.new-discussion-timeline.experiment-repo-nav > div.repository-content > div > div.border-right.border-bottom.border-left'
            let text = await page.$eval(ITEM, el => {
                let items = Array.from(el.querySelectorAll('li'))
                let infoObj = items.map((item, index) => {
                    let details = item.querySelector('.opened-by')
                    let comments = item.querySelector('div.float-right.col-5.no-wrap.pt-2.pr-3.text-right > a > span')
                    let issuesTypeDom = Array.from(item.querySelectorAll('div.float-left.col-9.lh-condensed.p-2 > span > a'))
                    let issuesTypeList = []
                    if (issuesTypeDom.length > 0) {
                        issuesTypeDom.forEach(element => {
                            issuesTypeList.push(element.innerText)
                        });
                    }
                    return {
                        issueName: item.querySelector('.h4').innerText,
                        issueNo: details.innerText.split(' ')[0].trim().replace('#', ''),
                        issueReporter: details.querySelector('.muted-link').innerText,
                        issueTime: document.getElementsByTagName('relative-time')[index].title.replace('GMT+8', ''),
                        issueAnswers: comments ? comments.innerText : 0,
                        issuesType: issuesTypeList.length > 0 ? issuesTypeList : null
                    }
                })
                return infoObj
            });
            return text
        } catch (error) {
            console.log(error);
        }
    }
    async getTotlePage(page) {
        try {
            let lastPageText = await page.$$eval('.pagination a', el => {
                let length = el.length
                return el[length - 2].innerText
            })
            return lastPageText
        } catch (error) {
            console.log('暂无issue');
            process.exit(1)
        }

    }
    // 关闭浏览器
    async closeBrowser(browser) {
        console.log('正在关闭浏览器...')
        await browser.close()
        process.exit(1)
    }
}

// 启用爬虫
async function main() {
    await new shellIO().init()
    await new OnePaChong().init()
}

main()