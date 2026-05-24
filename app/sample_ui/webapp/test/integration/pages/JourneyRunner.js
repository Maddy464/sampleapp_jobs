sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"com/demo/sample/sampleui/test/integration/pages/BooksList",
	"com/demo/sample/sampleui/test/integration/pages/BooksObjectPage"
], function (JourneyRunner, BooksList, BooksObjectPage) {
    'use strict';

    var runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('com/demo/sample/sampleui') + '/test/flp.html#app-preview',
        pages: {
			onTheBooksList: BooksList,
			onTheBooksObjectPage: BooksObjectPage
        },
        async: true
    });

    return runner;
});

