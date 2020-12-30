const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const stream = require('stream');
const util = require('util');
const fetch = require('node-fetch');
const minify = require('@node-minify/core');
const htmlMinifier = require('@node-minify/html-minifier');
const ProgressBar = require('progress');
const cheerio = require('cheerio');
const _ = require('lodash');
const async = require('async');
const puppeteer = require('puppeteer');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const app = express();

app.use(cors());
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

app.get('/', function (req, res) {
    res.render('pages/index');
});

const indexHtml = async (url, content, browser) => {
    const now = new Date();
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].join('_');
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()].join('_');
    const dateTimeString = [date, time].join('_');
    const filename = url
        .replace('https://', 'https_')
        .replace('http://', 'http_')
        .replace('ftp://', 'ftp_')
        .replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const directory = path.join('data', filename);

    fs.mkdirSync(directory, {recursive: true});

    const $ = cheerio.load(content);
    let keywords = [];
    let metaKeywords = $('meta[name="keywords"]').attr('content');

    if (metaKeywords) {
        metaKeywords = metaKeywords.toLowerCase().split(',');
        keywords = _.concat(keywords, metaKeywords);
    }

    try {
        const stylesheets = $('link[rel="stylesheet"]');
        for (let i = 0; i < stylesheets.length; i++) {
            const element = $(stylesheets[i]);
            const href = new URL(element.attr('href'), url).href;

            const response = await fetch(href);
            const content = await response.text();

            element.replaceWith(`<style>\n${content}</style>`);
        }
    } catch (e) {
        console.error(e);
    }

    try {
        const metaIcons = $('link[href]');
        for (let i = 0; i < metaIcons.length; i++) {
            const element = $(metaIcons[i]);
            const originalHref = element.attr('href');
            element.attr('href', originalHref.substr(1));
            const absoulteHref = new URL(originalHref, url).href;
            const relativeHref = absoulteHref.replace(url, '');
            const dirname = path.join(directory, path.dirname(relativeHref));
            let filename = path.basename(relativeHref);

            if (filename.includes('?')) {
                filename = filename.substr(0, filename.indexOf('?'));
            }

            const relativeFilepath = path.join(dirname, filename);

            fs.mkdirSync(dirname, {recursive: true});

            const response = await fetch(absoulteHref);
            const streamPipeline = util.promisify(stream.pipeline);

            await streamPipeline(response.body, fs.createWriteStream(relativeFilepath));
        }
    } catch (e) {
        console.error(e);
    }

    try {
        const images = $('img[src]');
        for (let i = 0; i < images.length; i++) {
            const element = $(images[i]);
            const originalHref = element.attr('src');
            element.attr('src', originalHref.substr(1));
            const absoulteHref = new URL(originalHref, url).href;
            const relativeHref = absoulteHref.replace(url, '');
            const dirname = path.join(directory, path.dirname(relativeHref));
            let filename = path.basename(relativeHref);

            if (filename.includes('?')) {
                filename = filename.substr(0, filename.indexOf('?'));
            }

            const relativeFilepath = path.join(dirname, filename);

            fs.mkdirSync(dirname, {recursive: true});

            const response = await fetch(absoulteHref);
            const streamPipeline = util.promisify(stream.pipeline);

            await streamPipeline(response.body, fs.createWriteStream(relativeFilepath));
        }
    } catch (e) {
        console.error(e);
    }
    fs.writeFileSync(path.join(directory, 'index.html'), $('html').contents(), 'utf-8');

    const body = $('body');
    let bodyText = body.text();
    bodyText = bodyText.split('\n');
    bodyText = _.map(bodyText, (line) => line.trim());
    bodyText = _.reject(bodyText, (line) => _.isEmpty(line));
    bodyText = bodyText.join(' ');

    let words = _.chain(bodyText)
        .words()
        .reject((word) => word.length < 5)
        .reject((word) => word[0] === word[0].toLowerCase())
        .countBy()
        .omitBy((count, group) => {
            return count < 2;
        })
        .value();

    keywords = _.concat(keywords, _.keys(words));
    keywords = _.chain(keywords).map(word => _.lowerCase(word)).uniq().sort().value();

    if (browser) {
        const page = await browser.newPage();
        await page.goto(url, {
            waitUntil: 'networkidle0'
        });
        await page.setViewport({width: 1920, height: 1080});
        // await page.pdf({
        //     path: path.join('data', filename + '.pdf'),
        //     format: 'A4',
        //     printBackground: true,
        //     displayHeaderFooter: true,
        //     width: 1920,
        //     height: 1080
        // });
        await page.screenshot({
            path: path.join('data', filename + '.png'),
            fullPage: true
        });
        await page.close();
    }

    return {
        title: $('title').text(),
        keywords: keywords,
        // content: bodyText,
        meta: {
            desc: $('meta[name="description"]').attr('content'),
            keywords: metaKeywords,
            ogTitle: $('meta[property="og:title"]').attr('content'),
            ogImage: $('meta[property="og:image"]').attr('content'),
            ogkeywords: $('meta[property="og:keywords"]').attr('content')
        }
    };
};

const indexUrl = async (url, browser) => {
    let status = -1;
    let ok = false;
    let data = null;

    try {
        const response = await fetch(url);
        const headers = response.headers;
        const contentType = headers.get('content-type').split(';');
        const content = await response.text();

        if (contentType.includes('text/html')) {
            data = await indexHtml(url, content, browser);
        }

        status = response.status;
        ok = response.ok;
    } catch (exception) {
        console.log(exception);
    }

    const result = {
        url,
        status,
        ok,
        data
    };

    return result;
};

app.post('/index/url', async (req, res) => {
    const {url} = req.body;
    const result = await indexUrl(url);
    res.json(result);
});

app.get('/about', function (req, res) {
    res.render('pages/about');
});

// app.listen(9999, () => {
//     console.log('9999 is the magic port');
// });

const links = [
    'https://malura.de',
];

const main = async () => {
    const browser = null; // await puppeteer.launch();
    const bar = new ProgressBar('indexing [:bar] :percent :rate/pps :etas', {total: links.length});

    // const results = [];

    await async.eachLimit(links, 10, async (link) => {
        const result = await indexUrl(link, browser);
        const {data} = result;

        bar.tick();

        if (bar.complete) {
            console.log('complete');
        }
    });

    // console.log(results);
    if (browser) {
        await browser.close();
    }
};

main().then(async () => {
    console.log('Done');
});

