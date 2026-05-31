var sinon         = require('sinon'),
    should        = require('chai').should(),
    flow          = require('../../helpers/flow'),
    defaults      = require('../../helpers/defaults');
    
module.exports = function() {  
  describe('User Login', function() {
    describe('When I enter an invalid login', function() {
      before(function(done) {
        flow.switchUser('');
        // log in the user with the wrong password
        flow.login({password:'nope'}, function(err, response) {
          done();
        });
      });

      it('should redirect me to the login page', function() {
        flow.wasOk.should.be.true;
        flow.lastResponse.statusCode.should.eql(302);
        flow.lastResponse.redirect.should.be.true;
        flow.lastResponse.headers.location.should.eql('/login');
        flow.lastRedirect.pathname.should.eql('/login');
      });

      it('should not let me visit the welcome page', function(done) {
        flow.welcome(function() {
          flow.wasOk.should.be.true;
          flow.lastResponse.statusCode.should.eql(302);
          flow.lastRedirect.pathname.should.eql('/login');
          done();
        });
      });
    });

    describe('When I enter a valid login', function() {
      before(function(done) {
        flow.switchUser('user');
        done();
      });

      it('should redirect to the home page', function(done) {
        // log in the user
        flow.login(function(err, response) {
          flow.wasOk.should.be.true;
          flow.lastResponse.statusCode.should.eql(302);
          flow.lastResponse.redirect.should.be.true;
          flow.lastResponse.headers.location.should.eql('/home');
          flow.lastRedirect.pathname.should.eql('/home');

          done();
        });
      });

      it('should allow the home page to load', function(done) {
        flow.home(function(err, response) {
          flow.wasOk.should.be.true;
          response.statusCode.should.eql(200);
          done();
        });
      });
    });

    describe('When I enter a valid upper case email address', function() {
      before(function(done) {
        flow.switchUser('');
        flow.login({ email : defaults.login.email.toUpperCase() }, function(err, response) {
          done();
        });
      });

      it('should redirect to the home page', function(done) {
        flow.wasOk.should.be.true;
        flow.lastResponse.statusCode.should.eql(302);
        flow.lastResponse.redirect.should.be.true;
        flow.lastRedirect.pathname.should.eql('/home');

        done();
      });
    });
  });
};
