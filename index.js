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

const getDirectoryPathForUrl = (pageUrl) => {
    const now = new Date();
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].join('_');
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()].join('_');
    const dateTimeString = [date, time].join('_');
    const filename = pageUrl
        .replace('https://', 'https_')
        .replace('http://', 'http_')
        .replace('ftp://', 'ftp_')
        .replace(/[^a-z0-9]/gi, '_').toLowerCase();

    return path.join('data', filename);
};

const downloadFileToPageDirectory = async (pageUrl, absoluteFileUrl, bar) => {
    const directory = getDirectoryPathForUrl(pageUrl);
    const relativeHref = absoluteFileUrl.replace(new URL(absoluteFileUrl).origin, '');
    const dirname = path.join(directory, path.dirname(relativeHref));
    let filename = path.basename(relativeHref);

    if (filename.includes('?')) {
        filename = filename.substr(0, filename.indexOf('?'));
    }

    const relativeFilepath = path.join(dirname, filename);


    try {
        const response = await fetch(absoluteFileUrl);

        fs.mkdirSync(dirname, {recursive: true});
        const streamPipeline = util.promisify(stream.pipeline);
        await streamPipeline(response.body, fs.createWriteStream(relativeFilepath));

        return true;
    } catch (e) {
        bar.interrupt(`Could not download '${absoluteFileUrl.substr(0, 80)}'`);
    }

    return false;
};

const getLocalUrl = (pageUrl, absoluteDownloadedUrl) => {
    const origin = new URL(absoluteDownloadedUrl).origin;
    return absoluteDownloadedUrl.replace(origin + '/', '');
};

const removeLeadingSlash = (string) => {
    return string.replace(/^\//, '');
};

const getDownloadableUrl = (pageUrl, url) => {
    const origin = new URL(pageUrl).origin;
    let downloadableUrl = null;

    if (url.match(/^[\/.]/)) {
        downloadableUrl = new URL(url, origin).href;
    } else if (url.match(/^https?:\/\//i)) {
        downloadableUrl = url;
    } else if (url.match(/^[\w]/i)) {
        downloadableUrl = new URL('/' + url, origin).href;
    } else {
        console.error(`Cannot parse url '${url.substr(0, 80)}'`);
    }

    return downloadableUrl;
};

const indexHtml = async (pageUrl, content, bar) => {
    const directory = getDirectoryPathForUrl(pageUrl);
    fs.mkdirSync(directory, {recursive: true});

    const $ = cheerio.load(content);
    let keywords = [];
    let metaKeywords = $('meta[name="keywords"]').attr('content');

    if (metaKeywords) {
        metaKeywords = metaKeywords.toLowerCase().split(',');
        keywords = _.concat(keywords, metaKeywords);
    }

    const stylesheets = $('link[rel="stylesheet"]');

    for (let i = 0; i < stylesheets.length; i++) {
        const element = $(stylesheets[i]);
        const href = new URL(element.attr('href'), pageUrl).href;

        try {
            const response = await fetch(href);
            const content = await response.text();

            element.replaceWith(`<style>\n${content}</style>`);
        } catch (e) {
            bar.interrupt(`Could not fetch stylesheet ${href.substr(0, 80)}`);
        }
    }

    // try {
    //     const stylesheets = $('style');
    //     for (let i = 0; i < stylesheets.length; i++) {
    //         const element = $(stylesheets[i]);
    //         let content = element.contents().text();
    //
    //         let imports = [];
    //
    //         // while (true) {
    //         //     const found = content.match(/@import url\("(.*)"\)/);
    //         //
    //         //     if (!found) {
    //         //         break;
    //         //     }
    //         //
    //         //     // const [group, cssUrl, offset, all] = found;
    //         //     // const importDownloadableUrl = getDownloadableUrl(pageUrl, cssUrl);
    //         //     // const importResponse = await fetch(importDownloadableUrl);
    //         //     // const importContent = await importResponse.text();
    //         // }
    //
    //         // const response = await fetch(href);
    //         // const content = await response.text();
    //         //
    //         // element.replaceWith(`<style>\n${content}</style>`);
    //     }
    // } catch (e) {
    //     console.error(e);
    // }

    const metaIcons = $('link[href][rel="apple-touch-icon"]');
    for (let i = 0; i < metaIcons.length; i++) {
        const element = $(metaIcons[i]);
        const url = element.attr('href');

        try {
            if (url === pageUrl) continue;
            if (element.attr('rel') === 'canonical') continue;

            element.attr('href', removeLeadingSlash(url));
            const absoluteFileUrl = new URL(url, pageUrl).href;

            const dowloaded = await downloadFileToPageDirectory(pageUrl, absoluteFileUrl, bar);
        } catch (e) {
            bar.interrupt(`Could not fetch meta icon ${href.substr(0, 80)}`);
        }
    }

    const images = $('img[src]');
    for (let i = 0; i < images.length; i++) {
        const element = $(images[i]);
        const url = element.attr('src');
        let downloadableUrl = getDownloadableUrl(pageUrl, url);

        try {
            if (downloadableUrl) {
                const downloaded = await downloadFileToPageDirectory(pageUrl, downloadableUrl, bar);

                if (downloaded) {
                    const localUrl = getLocalUrl(pageUrl, downloadableUrl);
                    element.attr('src', localUrl);
                }
            }
        } catch (e) {
            bar.interrupt(`Could not fetch image ${downloadableUrl.substr(0, 80)}`);
        }
    }

    const htmlContent = $.html($('html'));

    fs.writeFileSync(path.join(directory, 'index.html'), htmlContent, 'utf-8');

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
        await page.goto(pageUrl, {
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

const indexUrl = async (url, bar) => {
    let status = -1;
    let ok = false;
    let data = null;

    try {
        const response = await fetch(url);
        const headers = response.headers;
        const contentType = headers.get('content-type').split(';');
        const content = await response.text();

        if (contentType.includes('text/html')) {
            data = await indexHtml(url, content, bar);
        }

        status = response.status;
        ok = response.ok;
    } catch (exception) {
        bar.interrupt(`Could not index '${url}'`);
    }

    return {
        url,
        status,
        ok,
        data
    };
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

const links = fs.readFileSync('./links.txt', {encoding: 'utf-8'}).split('\n');
const offline = fs.readFileSync('./offline.txt', {encoding: 'utf-8'}).split('\n');

const main = async () => {
    const bar = new ProgressBar('indexing [:bar] :percent :rate/pps :etas', {total: links.length});

    await async.eachLimit(links, 1000, async (link) => {

        if (offline.includes(link)) {
            bar.tick();
            bar.interrupt(`Skip ${link}`);
        }

        const {
            url,
            status,
            ok,
            data
        } = await indexUrl(link, bar);

        if (!ok) {
            if (status === -1) {
                fs.writeFileSync('./offline.txt', `${link}\n`, {
                    encoding: 'utf-8',
                    flag: 'a'
                });
            }
        }

        bar.tick();

        if (bar.complete) {
            console.log('complete');
        }
    });
};

main().then(async () => {
    console.log('Done');
});

